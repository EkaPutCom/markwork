# The app protocol: design

Status: draft, nothing implemented. It describes how a frontend in another process or language (Tauri, Electron, GPUI) drives the Markwork application. The GTK frontend keeps calling `AppSession` in its own process (section 3.3) and is the reference every other frontend is checked against.

What it builds on: the core runs on Node as well as GJS (`src/platform/node/`, `npm run test:core:node`), and `AppSession` (`src/app/session.ts`) owns the feature controllers given one `AppFrontend`: the views, the dialogs, and the document hooks a frontend implements. This protocol is `AppFrontend` and the command table (`src/app/commands.ts`) carried over a wire.

## 1. Goals and non-goals

Goals

- One application, many frontends. Everything that decides something (the Markdown rules, documents, saving, boards, the agent and its approval rule, Git, forges, the harness) stays in the core process. A frontend draws and reports what the user did.
- Typing never waits for the other process. The editor owns the live text and its highlighting (section 5); the core gets the text as small edits after the fact.
- Every message is plain JSON. No callback, function, `Set`, `Date`, or class crosses the line.
- The same framing as markworkd (`docs/design/markworkd.md`, section 3), so one line reader, one test style, and one mental model serve both.
- Language-neutral. The core process may later be rewritten (in Go, piece by piece) without a frontend noticing, so the protocol never exposes a TypeScript type that is not described here.

Non-goals (v1)

- Several frontends attached to one core at the same time. One core process serves one window.
- A network endpoint. The core process is a child of the frontend, reached over stdio or a pipe.
- Sharing the editor's highlighting between frontends. Each frontend's editor shows Markdown its own way (GtkSourceView today, CodeMirror or GPUI later); only the text and the cursor cross the line.
- Collaborative editing (operational transforms, CRDTs). There are two writers of a document's text, the user and the core, and the rare core write is checked against a version instead (section 5.4).

### 1.1 Prior art, and why this shape

Splitting an application into a UI and a core that talk by messages is common; how the text of a document is shared across that line is where such designs succeed or fail.

- **The Language Server Protocol, and VS Code's extension host.** The editor owns the text and sends a language server small edits tagged with the document's version (`didChange`); the server keeps its own copy. When the server wants to change the text, its edit names the version it was computed against, and the editor refuses it if the document has moved on. VS Code treats the extensions it runs in a separate process the same way. This is the shape of sections 5.3 and 5.4 (`doc.edit`, `doc.replace` with `base`, `conflict`), and it is in daily use by nearly every modern editor.
- **Tauri, Electron, Neovim.** A UI process and a backend that talk by messages are the normal shape of the first two, and Neovim's external GUIs speak to its core over RPC. A Markwork on Tauri or Electron has this split whether this protocol exists or not; the protocol decides where the line runs.
- **Xi Editor, the cautionary case.** Xi put the text in a Rust core and had native frontends draw it over JSON-RPC, so every keystroke crossed the process boundary. The project was stopped, and its author's retrospective names the cost of editing across that boundary as a large part of why. This design draws the line on the other side of the editor for that reason (section 3.2): typing, undo, and highlighting stay in the frontend.
- **Shared cores in product apps.** One core under several native UIs is common (password managers, messengers, apps that share logic between iOS and Android), but most call the core in the same process through a foreign-function interface rather than through a second process and JSON. It is not free either: Dropbox wrote in 2019 about leaving its C++ code shared between iOS and Android, because keeping it shared cost more than it saved.

What follows for Markwork:

- The hardest part, keeping two copies of a text in step, copies the most-tried pattern there is (LSP), not a new invention.
- The cost is real: two processes, the races of section 10, and harder debugging. It pays off only once there is a second frontend.
- So the GTK frontend keeps calling `AppSession` in its own process (3.3), and the protocol itself is built when a second frontend is actually started (section 15). The prerequisites of section 13 (moving chat, the file tree, search, and history into `app/`) are worth doing for the GTK app regardless.

## 2. Concepts

| Term | Meaning |
| --- | --- |
| core | The process that runs `AppSession`, the core modules, and a platform port (`platform/node/` or `platform/gjs/`). |
| frontend | The process that shows the window: widgets, the editor, dialogs, menus, keyboard. |
| document | One open tab, identified by `doc`, a number the core chooses (`Doc.id` today). The Home tab is a document with `home: true`. |
| version | A per-document counter of the text. The frontend bumps it with every edit it sends; the core's own writes carry the version they were made against. |
| replica | The core's copy of a document's text, kept current by the frontend's edits. Every read of the text in the core (saving, the agent's context, boards, autosave) reads the replica. |
| view | Something the core asks the frontend to draw: a page (Home, a board, a review), a panel (collaboration, history), or a status (counts, busy). Described by snapshots of plain data. |
| action | What the user did in a view (clicked Merge, moved a card), sent by the frontend. Replaces today's `on*` callbacks. |
| ask | A question the core puts to the user through the frontend (save changes?, choose a folder, approve this change). Replaces today's dialog functions that return a value or a Promise. |
| command | An entry of the command table (`COMMANDS` in `app/commands.ts`): menus, shortcuts, and the palette. |

## 3. Process model

```
 frontend process                                  core process
 ┌──────────────────────────────────┐              ┌──────────────────────────────────┐
 │ window, widgets, menus, dialogs   │   protocol   │ AppSession: controllers, commands │
 │ editor + its highlighting         │ ───────────▶ │ core: markdown, agent, forge, git │
 │ the live text of each document    │ ◀─────────── │ replicas of the open documents    │
 └──────────────────────────────────┘  JSON lines  │ platform/node (or platform/gjs)   │
                                                   └──────────────────────────────────┘
```

### 3.1 Who starts whom

The frontend starts the core and owns its lifetime.

| Frontend | Core process | Transport |
| --- | --- | --- |
| Tauri | A Node sidecar (`markwork-core`), bundled with the app | its stdin and stdout |
| Electron | A utility process, or the main process | `MessagePort`, one JSON message per post |
| GPUI | The same Node sidecar as Tauri | its stdin and stdout |
| GTK | none: `AppSession` in the window's own process | direct calls (3.3) |

stderr of the sidecar is a log, never protocol. A sidecar that exits ends the session; the frontend shows the reason (the stderr tail) and offers to restart. Unsaved text is not lost, because the frontend holds it (section 5).

### 3.2 Why the editor stays with the frontend

A keystroke that had to cross a process boundary before the screen changed would make typing feel slow, and every editor (GtkSourceView, CodeMirror, a GPUI editor) already has its own buffer, undo, and highlighting. So the line is drawn above the editor: the frontend edits, highlights, and undoes locally, and tells the core what changed.

### 3.3 The in-process binding (GTK)

The GTK frontend keeps implementing `AppFrontend` directly; it does not serialize anything. To keep it honest, every message of this protocol has a matching method in the in-process interfaces, and the protocol adapter (`app/protocol/`, section 14) is a thin translation between the two. The rule that makes this work: an `AppFrontend` member may only take and return the plain data this document allows (section 4.4). Today's interfaces break that rule in a few places, listed in section 13.

## 4. Transport and framing

### 4.1 Lines

UTF-8 JSON, one message per line, `\n` terminated, no embedded newlines; the same as markworkd. Maximum frame 16 MiB (a whole document is sent once when it opens; a larger document is an error the frontend reports, not a silent truncation). Over a `MessagePort` the same objects are posted without the line framing.

### 4.2 Message shapes

Both sides may send requests; either side answers the other's.

```
request        {"id":"f12","op":"<name>", ...params}            id: unique per sender ("f…" frontend, "c…" core)
reply          {"re":"f12","ok":true, ...result}
               {"re":"f12","ok":false,"error":{"code":"<code>","message":"<text>"}}
notice         {"ev":"<name>", ...payload}                      no reply
```

Requests from the frontend are mostly user actions and commands; requests from the core are asks (section 7) and its own text edits (section 5.4). Notices from the core carry view state (section 6); notices from the frontend carry text edits and the cursor (section 5).

### 4.3 Order

Messages are handled in the order they were sent on the one connection. This is what keeps the replica right: the frontend sends a document's pending edits before any request that may read it (section 5.3), so by the time the core handles "Save" it has every keystroke that came before it.

### 4.4 Values

- Numbers are JSON numbers; times are Unix milliseconds (`ts`), never `Date`.
- Text offsets are counted in Unicode code points from the start of the document, the unit `TextEditor.cursorOffset` and GTK use today. A frontend whose editor counts UTF-16 code units (CodeMirror, the web) converts at its edge.
- Sets and maps are arrays and objects. `ReadonlySet<number>` becomes a sorted array.
- A callback becomes an id: a toast's button, a menu entry, or a test of a typed token is named, and the frontend sends that name back in an action (section 6.4).
- Paths are absolute, as the core uses them. The frontend never builds a path the core then trusts for writing; it may only pass back a path the core gave it or one the user chose in a file dialog (section 9).

### 4.5 Session start

```
frontend → core   {"id":"f1","op":"hello","proto":1,"frontend":"tauri","version":"0.9.0",
                   "caps":{"editor":"codemirror","notify":true,"terminal":false}}
core → frontend   {"re":"f1","ok":true,"proto":1,"core":"markwork 0.9.0",
                   "commands":[ ... section 8 ... ],"settings":{ ... section 9.2 ... }}
frontend → core   {"id":"f2","op":"start"}             AppSession.start(): restore the tabs of the last session
```

`proto` is an integer that grows only with incompatible changes. New ops, fields, and notices are additive within a version: a receiver ignores fields and notices it does not know, and answers an unknown op with `unknown_op`.

## 5. Documents and their text

This is the part that most needs to be right, so it gets the most detail.

### 5.1 Ownership

- The frontend's editor owns the live text of a document. It applies keystrokes, keeps the undo history, and highlights.
- The core keeps a replica of every open document's text and a version number. It never reads text from anywhere else for an open document.
- The core decides which documents are open, which one is active, what each one shows (text, board, Home), and when it is saved (`DocumentController`, `ViewController`, `Autosaver` stay as they are).

### 5.2 Opening and closing

The core tells the frontend about documents; the frontend never invents one.

```
core → frontend   {"ev":"doc.open","doc":3,"file":"/home/eka/notes/plan.md","title":"plan","home":false,
                   "text":"# Plan\n…","version":0,"modes":{"source":false,"focus":false,"typewriter":false},
                   "cursor":120}                                      DocumentsHost.attach + TextEditor.setText
core → frontend   {"id":"c30","op":"doc.close","doc":3,"version":18}  DocumentsHost.detach (a request, 5.2.1)
core → frontend   {"ev":"doc.active","doc":3}                         DocumentsHost.activated
core → frontend   {"ev":"doc.title","doc":3,"title":"plan","icon":null,"modified":false}
frontend → core   {"ev":"tabs.order","docs":[1,3,2]}                  DocumentsHost.tabOrder, after the user drags a tab
```

Reopening a file the core already shows replaces its text with `doc.reset` (the same fields as `doc.open`), outside the undo history, and starts again at version 0.

#### 5.2.1 Closing is a request

The core may close a document on its own (the agent deleted its file, a reload), possibly while keystrokes are still on their way. So closing is a request that carries the version the core decided on:

```
core → frontend   {"id":"c30","op":"doc.close","doc":3,"version":18}
frontend → core   {"re":"c30","ok":true}
                  {"re":"c30","ok":false,"error":{"code":"conflict","message":"edited since"},"version":20}
```

The frontend first sends its pending edits (5.3), then closes only if its version is still `version`. Otherwise it keeps the tab and answers `conflict`; the core, which by then has versions 19 and 20, decides again (ask to save, keep the text as an unsaved document). Nothing the user typed is dropped by a close that crossed it.

### 5.3 Edits from the frontend

```
frontend → core   {"ev":"doc.edit","doc":3,"version":18,"modified":true,
                   "changes":[{"from":120,"to":120,"insert":"a"},{"from":130,"to":134,"insert":""}]}
```

- `changes` are applied in order, each against the text as left by the previous one. `version` is the version after this message: one higher than the last one the core saw for this document. A gap is a bug; the core answers with a `doc.resync` request (5.6).
- A version is given to a batch when it is sent, not to each keystroke. Edits the editor has made but not sent yet are *pending*; they have no version, and the core cannot know about them.
- The frontend keeps the edits of every version the core may still refer to (from the oldest `base` of a `doc.replace` it has not answered, which is at most one per document, 5.4), so it can rebase a change from the core over them.
- The frontend coalesces keystrokes: it sends what has piled up when the editor is idle (about 100 ms), and always before it sends any request or reply (a command, an action, an answer to an ask, the answer to a `doc.replace` or `doc.close`). Ordering (4.3) then guarantees the core reads the text the user saw.
- `modified` is the editor's own "changed since saved" flag, so undoing back to the saved text clears it, as GTK's modified flag does today.
- The cursor and the selection travel separately and less often:

```
frontend → core   {"ev":"doc.cursor","doc":3,"version":18,"offset":121,"selection":[118,121]}
```

The core needs the cursor for the agent's context, for inserting at the cursor, and to restore it when a tab reopens. Headings, word counts, and outlines are computed by the core from the replica; the frontend does not send them.

### 5.4 Edits from the core

The core changes a document's text when a board or list commits a change, when a journal entry is inserted, when the agent applies an approved change to an open document, or when a file is reloaded. All of them become one request:

```
core → frontend   {"id":"c40","op":"doc.replace","doc":3,"base":18,"undo":"step",
                   "changes":[{"from":200,"to":200,"insert":"- [ ] Call Sari\n"}],"cursor":null}
frontend → core   {"re":"c40","ok":true,"version":19,"applied":[{"from":200,"to":200,"insert":"- [ ] Call Sari\n"}]}
                  {"re":"c40","ok":false,"error":{"code":"conflict","message":"text changed"},"version":21}
```

- `base` is the version the core computed the change against. The frontend handles the request in this order:
  1. It sends its pending edits as a `doc.edit` (5.3), so they get a version and reach the core before the reply.
  2. If its version is `base`, it applies `changes` as they are.
  3. Otherwise it rebases `changes` over the edits of the versions after `base`. A change from the core that touches none of the ranges those edits touched (overlapping or adjacent counts as touching) only shifts by the length those edits added or removed before it, and is applied at the shifted place.
  4. If a change from the core touches what the user edited since `base`, it applies nothing and answers `conflict` with its current version.
- The `ok` reply carries the new version and `applied`, the changes exactly as the editor applied them (after any shift). The core applies `applied` to its replica; it never applies its own `changes` first.

```
frontend → core   {"ev":"doc.edit","doc":3,"version":19,"changes":[…]}             step 1: the pending edits
frontend → core   {"re":"c40","ok":true,"version":20,"applied":[{"from":204,"to":204,"insert":"- [ ] Call Sari\n"}]}
```

- The replica changes in exactly two ways: a `doc.edit` from the frontend, or the `applied` of an `ok` reply to a `doc.replace`. Ordering (4.3) puts both in the order the editor applied them, so replica and editor never disagree about what version N means.
- At most one `doc.replace` per document is in flight. The core queues the next one until the reply arrives, and computes it against the replica at that moment, not against the replica it had when it was queued.
- `undo: "step"` makes the change one undo step (`TextEditor.replaceText`, `insertAtCursor`); `"none"` keeps it out of the history (`setText` on reload). `cursor` moves the cursor after the change (an offset) or leaves it (`null`).
- On a conflict the core does what its write paths already do when a file changed under them: it recomputes from the current replica, which by then has every edit the frontend made, and tries again. After three conflicts in a row it stops and reports it the way that write path reports a changed file today: `applyChange()` returns an error to the agent, a board change becomes a `stale` answer (6.3), a journal line is retried on the next activity.
- Conflicts are rare. A write the core makes in answer to something the user just did comes after the frontend flushed its edits (5.3), so `base` is already current. The writes that can meet unsent typing are the ones started by a timer or by background work: a harness run that ends and moves its card (`updateBoardFile`), a journal activity line, an agent change approved while the user went on typing. Rebasing (step 3) lets most of them through, since they rarely touch the line under the cursor.

### 5.5 How today's `TextEditor` maps

| `TextEditor` (app/document.ts) | Over the protocol |
| --- | --- |
| `getText()` | the replica |
| `setText(text)` | `doc.reset` (5.2): opening or reloading a file, outside the undo history; the replica takes the text at once, since the core is where that text comes from |
| `replaceText(text)` | the core diffs replica and `text` into the smallest `changes`, `undo: "step"` |
| `insertAtCursor(text)` | `doc.replace` at the last `doc.cursor` offset, `undo: "step"` |
| `update(edit)` | `edit` runs on the replica when no write of the core to that document is on its way, otherwise once it has landed; its result goes out as a `doc.replace` |
| `isModified()` / `setModified(false)` | the last `modified` from `doc.edit` / `doc.saved` notice (5.7) |
| `headings` | computed in the core from the replica |
| `jumpToLine(line)` | `doc.reveal` notice `{doc, line}` |
| `setMode(mode, on)` | `doc.mode` notice `{doc, mode, on}` |
| `cursorOffset` / `restoreCursor(offset)` | the last `doc.cursor` / the `cursor` field of `doc.open` |

A `ProtocolEditor` in the core implements `TextEditor` on the replica, so `AppSession` and every controller keep using `TextEditor` unchanged, with one difference that matters: a write is no longer visible at once. In one process, `replaceText(t)` followed by `getText()` gives `t`. Over the protocol, `getText()` keeps giving the replica until the frontend's `ok` arrives, because the replica only changes by what the editor applied (5.4). So a controller must not read back its own write in the same turn; it works on the value it computed (`serializeBoard(next)`, not `getText()` again), or, when it changes the text from what it is, it goes through `update(edit)`, which runs `edit` against the text as it is once earlier writes have landed. Two harness runs that end in the same turn and each move a card are the case that found this: the second `updateBoardFile()` read the text the first had just written, and over the protocol its whole-text write would have undone the first card (`app/views.ts` now uses `update()`; the test is in `tests/unit/appsession.ts`). An `update()` that runs later cannot hand its caller an error synchronously; `updateBoardFile()` then reports it as a toast.

### 5.6 Recovering

If the core sees a version gap, or the frontend answers `doc.replace` with an error other than `conflict`, the core asks for the whole text:

```
core → frontend   {"id":"c41","op":"doc.resync","doc":3}
frontend → core   {"re":"c41","ok":true,"version":22,"text":"…","modified":true,"cursor":140}
```

The frontend's text wins: it is what the user sees.

### 5.7 Saving

Saving stays in the core (`DocumentController.save`, `Autosaver`). After a write it tells the editor where its save point is:

```
core → frontend   {"ev":"doc.saved","doc":3,"version":19,"file":"/home/eka/notes/plan.md"}
```

The editor marks version 19 as unmodified. If the user typed after version 19, the document stays modified. This is the rule `Autosaver` already follows in one process: it remembers its `changes` counter before a background write and marks the document saved only if the counter did not move (`app/autosave.ts`). The version is that counter, carried over the wire.

## 6. Views as state

### 6.1 The rule

Every view interface in `app/` has three kinds of members today, and each becomes one kind of message:

| Today | Over the protocol |
| --- | --- |
| `setX(...)`, `showX(...)`: the controller draws | a notice from the core, `view.<name>` with a snapshot |
| `onX` callbacks: the user acted | an action request from the frontend, `act.<name>` |
| getters (`page()`, `getBoard()`): the controller asks the view | state the core already owns; the getter reads it from the core's own record of what it last showed |

A snapshot replaces what the view showed before. Views here are small (a review's file list, Home, the collaboration list), so whole snapshots are simpler and cheaper than patches; a view that turns out too large for that gets a patch notice later, as an additive change.

### 6.2 Pages and the screen (`ViewScreen`)

```
core → frontend   {"ev":"view.page","page":"board","doc":3}         showText / showPage / showHome
core → frontend   {"ev":"view.home","data":{ ... HomeData ... }}
core → frontend   {"ev":"view.status","visible":true,"counts":"412 words","board":{"lists":3,"cards":17}}
core → frontend   {"ev":"view.layout","layout":"board","structured":true}   showLayout + setStructuredState
core → frontend   {"ev":"commands.state","enabled":["save","undo",…],"disabled":["board-add-card",…]}
```

`page()` is answered by the core from the last `view.page` it sent.

### 6.3 Structured documents (board, list, table, calendar, timeline, gallery, chart)

The Markdown text stays the single source of truth, and the rules that turn text into a board and back stay in the core (`markdown/kanban.ts`, `markdown/fields.ts`). A view of the notes works on a `Board`, which is plain data (`head`, `columns`, `footer`):

```
core → frontend   {"ev":"view.notes","doc":3,"page":"board","version":19,"board":{…},"groupField":null,
                   "agents":true,"notes":["Plan","Ideas",…]}         setBoard / replace + listNotes
frontend → core   {"id":"f30","op":"act.notes.edit","doc":3,"version":19,
                   "op":{"kind":"move","from":[1,4],"to":[3,0],"card":"Call Sari [due:: 2026-10-20]"}}   onChange
core → frontend   {"re":"f30","ok":true}
                  {"re":"f30","ok":false,"error":{"code":"stale","message":"the card is gone"}}
```

The frontend sends what the user did, not the board that resulted. A whole board is a picture of one moment: if the text changed while the user was dragging (an undo, a harness run that moved another card), the core could only accept the picture and lose the other change, or refuse it and lose the user's drag. An operation can be applied again to the board as it is now.

- The operations are the board functions the core already has, so the core applies them with the same code the GTK board uses: `add` (`addCard`), `update` (`updateCard`, a patch of text, checked, or fields), `delete` (`deleteCard`), `move` (`moveCard`), and `addColumn`, `renameColumn`, `deleteColumn` (`deleteColumnKeepCards`), `moveColumn`. A change the Fields… dialog makes travels as its answer (section 7), not as an operation.
- A card is named by its position and its text. If `version` is still the replica's, the position is trusted. Otherwise the core looks for the card by its text, in that column first; if it finds exactly one, it applies the operation there, and if it finds none or several, it answers `stale`, and the frontend redraws from the next `view.notes`. That is the only case in which a user's drag is not carried out, and the user sees why.
- After applying it, the core serializes the board, sends the difference as a `doc.replace` (5.4), and records the change for the journal, as `ViewController` does now; then it sends the new `view.notes`. Until that arrives the frontend shows its own result of the drag, so the board does not jump back.

### 6.4 Toasts, menus, and other callbacks

```
core → frontend   {"ev":"toast","text":"Moved to Done","action":{"label":"Undo","token":"t17"}}
frontend → core   {"id":"f31","op":"act.token","token":"t17"}

core → frontend   {"id":"c50","op":"ask.menu","at":{"view":"board","card":[1,4]},"entries":[
                     {"label":"Run with pi","token":"m1"},{"label":""},{"label":"Delete","token":"m2"}]}
frontend → core   {"re":"c50","ok":true,"token":"m2"}                          or "token":null when dismissed
```

A token is valid until the core replaces the view it belongs to. A token that arrives after that (the user clicked a toast's Undo just as the board changed) is answered with `stale` and does nothing; the frontend may say so in a toast. Today a toast's `run` closure would run against whatever is there by then; each such closure checks its target still exists, and the token makes that check one rule instead of many.

### 6.5 Every view interface, mapped

| Interface (file) | Notices (core → frontend) | Actions (frontend → core) |
| --- | --- | --- |
| `ViewScreen` (app/views.ts) | `view.page`, `view.home`, `view.status`, `view.layout`, `commands.state`, `find.close` | none |
| `NotesView`, `KanbanView`, `CaptureView` (app/views.ts) | `view.notes`, `view.focusCapture` | `act.notes.edit` (6.3) |
| `HarnessBoard`, `HarnessLogs` (app/harness.ts) | `view.notes` (a run's state is part of the card), `view.runlog` | `act.card.run`, `act.card.stop`, `act.runlog.open` |
| `CollabView` (app/collab.ts) | `view.collab` `{note, server, pulls}` | `act.collab.open`, `.refresh`, `.server`, `.send` |
| `PullReviewView` (app/pulls.ts) | `view.pull` with `pull`, `files`, `fileView`, `discussion`, `busy`, `resolving`, `message`, `commenting` | `act.pull.close`, `.select`, `.merge`, `.browser`, `.comment`, `.resolve`, `.finish`, `.abort` |
| `ReviewView` (app/harnessreview.ts) | `view.review` with `header`, `files`, `included`, `busy`, `commits`, `status`, `diff` (commented lines as an array), `tab`, `summary`, `replies`, `banner` | `act.review.close`, `.select`, `.include`, `.finish`, `.reply`, `.folder`, `.terminal`, `.tab`, `.log`, `.banner`, `.comment` |
| `HistoryTabView`, `HistoryViewersView` (app/history.ts) | `view.history` `{commits, more, note}`, `view.historyChanges` `{file, state, changed}`, `history.messageText`; `view.historyViewer.open` `{viewer, file, commit}`, `.diff`, `.content`, `.messageText`, `.close` | `act.history.refresh`, `.more`, `.open` `{hash}`, `.openChanges` `{path}`, `.commit` `{files, message}`, `.discard` `{path}`, `.write` `{files}`, `.stopWriting`; `act.historyViewer.commit`, `.discard`, `.write`, `.stopWriting`, `.closed` `{viewer}` |
| `ChatPanelView` (app/assistant.ts) | `chat.settings`, `chat.busy`, `chat.turn` `{turn, question}`, `chat.context`, `chat.text` / `chat.reasoning` `{turn, delta}`, `chat.tool`, `chat.work`, `chat.end` `{turn, outcome}`, `chat.noKey`, `chat.saveFailed` | `act.chat.send`, `.stop`, `.reset`, `.preview`, `.options`, `.chats`, `.open`, `.delete`, `.undo`, `.insert`, `.model`, `.thinking`, `.save`, `.key` |

A streamed answer is many small `chat.text` notices; the frontend appends. They are the only high-rate notices the core sends.

## 7. Asks (dialogs)

Every dialog function a controller is given becomes a request from the core. The core awaits the reply, which may come minutes later; it never blocks anything else while it waits, as today's `Awaitable` already allows.

```
core → frontend   {"id":"c60","op":"ask.saveChanges","document":"plan"}
frontend → core   {"re":"c60","ok":true,"answer":"save"}                 "save" | "discard" | "cancel"
core → frontend   {"ev":"ask.cancel","ask":"c61"}
```

`ask.cancel` withdraws a question the core no longer needs answered (the turn was stopped while a proposal waited); the frontend closes the dialog without replying.

An answer and a cancel can cross on the wire. The core decides, because it is the one that acts on the answer:

- Once the core has sent `ask.cancel`, the ask is over. An answer that arrives after that is dropped, even one the frontend sent first. The code that was waiting has already gone on as if the user said no (a cancelled proposal ends as rejected, as `ChatPanelView.review` does today: `onApply` after `cancelReview` is refused), so a change the user approved in that instant is not written; the turn that proposed it was stopped anyway.
- The frontend ignores an `ask.cancel` for an ask it has already answered.

Whatever the answer, the code that continues after it checks again that what it is about to act on still exists (the document is open, the card is there, the pull request is still open), as `AGENT.md` already asks of every continuation after a dialog. Over the protocol the wait is longer, so the check matters more, not less.

| Today (file) | Ask | Answer |
| --- | --- | --- |
| `DocumentDialogs.askSaveChanges` (app/documents.ts) | `ask.saveChanges {document}` | `"save" \| "discard" \| "cancel"` |
| `DocumentDialogs.showError` | `error` notice `{message}` | none |
| `DocumentDialogs.chooseFile` (app/dialogs.ts) | `ask.file {title, save, selectFolder, filters, name, folder}` | a path or `null` |
| `JournalDialogs.capture` | `ask.capture` | text or `null` |
| `CollabDialogs.token` | `ask.token {repo, hasToken, source}`; the dialog's Test button sends `act.collab.testToken {ask, token}`, answered with the sentence or an error | token, `""` (forget), or `null` |
| `PullDialogs.merge / local / abort` | `ask.pull.merge {pull, method}`, … | `true` / `false` |
| `ContributeDialogs.send` | `ask.sendChanges {SendChangesOptions}` | `SendChangesAnswer` or `null` |
| `HarnessDialogs.*` | `ask.folder`, `ask.harness.answer {ask, agent}`, `ask.text`, `ask.remoteFolder`, `ask.closeAgents` | as today |
| `ReviewDialogs.merge / discard` | `ask.review.merge`, `ask.review.discard` | `true` / `false` |
| `HistoryDialogs.discard` (app/history.ts) | `ask.discard {kind, path, viewer}`; `viewer` names the window it was asked from, `null` the History tab | `true` / `false` |
| `ViewDialogs.editSchema` | `ask.schema {fields, reserved, uses}`: `uses()` is a callback today, so the core sends the counts it would answer (`{"due": 4, "status:Done": 9}`) | `FieldDef[]` or `null` |
| `ChatPanelView.review` (app/assistant.ts) | `ask.proposal {changes, batch}`; while it is open the viewer may apply part of it with `act.proposal.apply {ask, chosen}` (`onApply`), answered with an error or `null`; `cancelReview` is the `ask.cancel` | `{note}`; the `ProposalResult` the agent gets is built by the core from what it wrote |

The last row keeps the agent's rule intact: a change is written only by the core, only after the user's decision in the frontend, and the core checks the text again before writing (`applyChange()`), whatever the frontend sent.

## 8. Commands

The command table travels once, in the `hello` reply:

```
{"id":"save","label":"Save","keys":["Ctrl+s"],"kind":"action","scope":"document","runs":"core"}
{"id":"bold","label":"Bold","keys":["Ctrl+b"],"kind":"action","scope":"text","runs":"editor"}
{"id":"chat","label":"Assistant","keys":["Ctrl+Shift+a"],"kind":"setting","scope":"always","runs":"core"}
```

- `runs` is new: `"editor"` commands are carried out by the frontend's editor without asking the core (undo, redo, bold, links, headings, table edits: today's `EditCommands`), so they stay instant. Everything else runs in the core.
- The frontend binds `keys` (in the neutral notation `app/commands.ts` uses: modifiers Ctrl, Alt, Shift, then the key, as in `Ctrl+Shift+p`), shows `label` in its menus and palette, and enables entries from `commands.state` (6.2).
- Running one:

```
frontend → core   {"id":"f70","op":"command","name":"save"}
frontend → core   {"id":"f71","op":"command","name":"layout","arg":"calendar"}
core → frontend   {"re":"f71","ok":true}
```

Commands that only open frontend things (the palette, the shortcuts window, About, Find) are `runs: "editor"` too: the core has nothing to do for them.

## 9. Settings, services, and trust

### 9.1 Services the frontend owns

Some things only the frontend can do. The core asks for them with notices or requests:

| Need (today's host member) | Message |
| --- | --- |
| `openUri(uri)` | `open.uri` notice |
| `notify(id, title, body)` | `notify` notice; the frontend decides whether a desktop notification is appropriate |
| `isActive()` | the frontend reports `window.active` notices `{active}`; the core keeps the last one |
| `toast(message, action)` | `toast` notice (6.4) |
| theme, dark mode | the frontend's own; the `color-scheme` setting is shared (9.2), and the frontend reports whether it is dark so the `colors.ts` palettes match |

### 9.2 Settings

`AppSettings` and its store stay in the core. The `hello` reply carries every setting; a change from either side is one message:

```
core → frontend   {"ev":"setting","key":"sidebar","value":false}
frontend → core   {"ev":"setting","key":"sidebar","value":true}
```

GSettings is the GTK store; the Node core keeps the same keys in a JSON file next to its configuration, with the defaults from `data/com.ekaput.Markwork.gschema.xml` (generated at build time, so the schema stays the one source of defaults).

### 9.3 Trust

- The core trusts its frontend as much as today's process trusts its window: they are one application.
- Writing stays guarded in the core. A path from the frontend is used only if it is one the core sent, or one the user just chose in an `ask.file` answer; the agent's path checks (`agent/path.ts`), the project-folder checks (`checkProjectFolder()`), and the check-before-write in `applyChange()` run in the core whatever the frontend says.
- Nothing listens on a network. The sidecar speaks only on stdio; the Electron core only on its `MessagePort`.

## 10. Concurrency and races

### 10.1 What changes

Today the GTK app runs on one thread, and a document's text exists once, in its GtkSourceView buffer. The user's keystrokes arrive as events between turns of the main loop, never in the middle of one. So a piece of code that reads the text, works out a change, and writes it back within one turn cannot be interrupted: `updateBoardFile()` (`app/views.ts`) reads `getText()`, edits the board, and calls `replaceText()` in one go, and no keystroke can land in between.

The protocol takes that guarantee away. The text exists twice, in the editor and in the replica, and every read the core makes may be one message out of date. No new kind of race appears that today's code has not met in a small way after an `await`; what disappears is the one-turn atomicity that made most of them impossible. The rule that replaces it, for every path in the core that reads text, waits, and then writes:

> Carry the version you read, and let the frontend check it when you write.

That is the rule `Autosaver` already follows with its `changes` counter, and the one `applyChange()` follows when it re-reads a file before writing an agent's change. The protocol applies it to every write of an open document.

### 10.2 The cases

| Case | Today, in one process | Over the protocol | Rule |
| --- | --- | --- | --- |
| A command (Save, Send changes) arrives while keystrokes are still pending | cannot happen: the buffer is the text | the core could read a replica without the last keystrokes | pending edits are sent before any request or reply (5.3) |
| The core writes while the user types, from a timer or background work: a harness run ends and moves its card, a journal activity line, an agent change approved while typing | cannot happen: read and write are one turn | `base` is behind the editor's text | the frontend flushes, then rebases a change that does not touch the user's edits, or answers `conflict`; the core retries from the newer replica, at most three times (5.4) |
| `doc.replace` and `doc.edit` cross on the wire | cannot happen | the core and the editor could apply changes in different orders | the replica changes only by `doc.edit` and by the `applied` of an `ok` reply, both in wire order; one `doc.replace` per document in flight (5.4) |
| The user drags a card while the text changes (an undo, another card moved by a run) | `ViewController` remembers `boardText` and reloads the board when the text changed by other means | a whole board sent by the frontend would overwrite the other change, or be refused | the frontend sends the operation, which the core applies to the board as it is now; `stale` only when the card cannot be found (6.3) |
| The core closes a document while keystrokes are on their way (the agent deleted its file) | the close happens in one turn | the last keystrokes would be lost | `doc.close` is a request with a version; the frontend refuses it if the text moved on (5.2.1) |
| A background save while the user types | `Autosaver` compares its `changes` counter before and after the write | the same, by version | `doc.saved` names the version written; later edits keep the document modified (5.7) |
| The user answers a dialog just as the core withdraws it | a `Cancellable` ends the wait as rejected | the answer and the cancel cross | a cancelled ask is over for the core; a later answer is dropped, a later cancel is ignored by the frontend (7) |
| A toast's Undo or a menu entry is clicked after its view changed | the closure runs against whatever is there | the same | the token is `stale` and does nothing (6.4) |
| An action is started twice (Merge clicked twice, a tab closed while it saves) | continuations re-check their state after each `await`; the same action answers `busy` | the same, with a wider window | unchanged, and every new path in `app/protocol/` follows it |

### 10.3 What the core may assume

- Messages from the frontend arrive in the order the frontend sent them, and the frontend sends its pending edits before anything that may read them.
- Within one turn of the core's own event loop, the replica does not change. A controller that reads the replica and calls `replaceText()` in the same turn still computes against one consistent text; only the frontend may refuse the result, and that refusal comes back as a message, never as a change under the controller's feet.
- Nothing else. Any `await` between reading and writing (a dialog, a Git run, an HTTP request, a model answer) means the text may have moved, and the write must carry the version it was computed from.

## 11. Errors

| Code | Meaning |
| --- | --- |
| `bad_request` | the message is not valid JSON or misses a field |
| `unknown_op` | the receiver does not know the op (an older peer) |
| `no_such_doc` | the document is closed or was never open |
| `conflict` | a versioned change was made against an older version (5.4, 6.3) |
| `cancelled` | the user or the core withdrew it |
| `busy` | the same action is already running (a merge, a send) |
| `stale` | a token, a card, or an ask refers to something that is no longer there (6.3, 6.4, 7) |
| `internal` | a bug; the message says what, and the core logs the stack to stderr |

## 12. Testing

- A fake frontend in Node drives a real `AppSession` over the protocol, in memory, the way `tests/unit/daemon-fake.ts` stands in for markworkd. Tests read like a transcript: messages in, messages out.
- The same scenarios run against the in-process binding (3.3) and over a real stdio pipe to the sidecar, so all three agree.
- The editor side is tested per frontend: a scripted edit sequence must leave the core's replica equal to the editor's text, including through `doc.replace` conflicts and `doc.resync`.
- Fuzzing the replica: random interleavings of `doc.edit` and `doc.replace` on generated text, checked against a model, before any real frontend uses it. After every step the replica must equal the editor's text at the same version.
- The races of section 10.2, each as a scripted scenario with the messages reordered the way the wire allows: a `doc.replace` that meets pending keystrokes (touching and not touching them), a `doc.close` that crosses an edit, a card dragged while a run moves another card, an answer that crosses an `ask.cancel`, a toast token used after its view changed. Each scenario has a pass condition the user would care about: no keystroke lost, no change applied twice, the drag carried out or reported as `stale`.

## 13. What must change first

Not everything a frontend shows goes through `AppSession` yet. These are wired straight in `src/window.ts` or own their core objects inside `ui/`, so a second frontend could not reach them. Each one needs a controller in `app/` (or a place in an existing one) before the protocol can carry it:

| Feature | Today | Needed |
| --- | --- | --- |
| Assistant | done: `AppSession` owns the `ChatController` through `app/assistant.ts`, which builds its host from the session; `ui/chat.ts` implements `ChatPanelView` (plain notices with a turn number, `on*` actions). Left: the log window follows the live `AgentTrace`, handed to the panel by `window.ts`; Undo names the changes by the objects the panel was given | a `chat.log` notice stream; Undo by an id of the applied changes |
| Proposal review | done: `ChatPanelView.review` is `ask.proposal`; the viewer asks `onApply(ask, chosen)` and the core writes, re-checking in `applyChange()`; an apply after `cancelReview` is refused | `ask.proposal` (7) |
| File tree | `ui/filetree.ts` read folders and moved files through `fileops.ts` (Gio) | done: `FilesController` (`app/files.ts`) lists and watches the folders and runs the operations through the port (`fs.copy` added for copying in); the tree is a view |
| Search and replace | done: `AppSession` owns a `SearchController` (`app/search.ts`) that searches the workspace's files (unsaved tabs from their editor), opens a hit, and replaces every hit as one batch after an ask; `ui/searchpanel.ts` implements `SearchView` (a `SearchQuery` out through `onSearch`, plain `SearchResults` in, a hit named by file and place in that file's list). Left: after Replace All the controller searches again at once, so while a write to an open document is still on its way the results show the text before it (the editor's `isModified()` is still false); a result refresh tied to the document's changes (5.4) closes it | `view.search` notice; `ask.confirm` |
| History and commits | done: `AppSession` owns a `HistoryController` (`app/history.ts`) that runs git and the commit message writer; `ui/history.ts` implements `HistoryTabView` and `ui/historyviewer.ts` `HistoryViewersView` (plain notices, `on*` actions, a viewer named by a number); the discard question is `HistoryDialogs.discard`. Left: the streamed message reaches the form as `messageText` notices, but the form's own Stop and lock stay in `ui/messagewriter.ts` | `view.history`, `view.historyViewer` notices; `ask.discard` |
| Outline | done: `AppSession` owns an `OutlineController` (`app/outline.ts`) that sends the active document's headings to `ui/outline.ts` (`OutlineView`) as plain data and jumps to a heading by its place in the list it sent, so a jump lands on the line the list had. The frontend calls `show(doc)` when a document becomes active and `changed(doc)` when its headings did; `TextEditor.headings` now carries the level | `view.outline` notice; the core computes the headings from the replica (5.1) |
| `[[` suggestions | the core side is done: `NoteLinks.namesFor(id)` answers for a document named by its id, and `window.ts` asks it everywhere (the editor, the board, the list, the table, the layouts). Left: the views still pull through `listNotes` callbacks in the frontend | the `notes` list of `view.notes`, and an `ask.notes` for the editor's popover |
| Preferences | done: `AppSession` owns a `PreferencesController` (`app/preferences.ts`). `ui/preferences.ts` is a `PreferencesView`: it opens with `PreferencesData` (every value as plain data, the choices of where agents run), reports `onSet(key, value)`, `onAddMachine`, and `onRemoveMachine(name)`, and is sent the values again while open when a setting changes anywhere. The core writes only the keys the dialog has and refuses a value the key does not take; adding a machine re-checks its name and host, and removing one forgets the choice of where agents run and its project folders. Left: the Projects group of the Agents page still reads `AppSettings` and runs git itself (`ui/projectsettings.ts`) | the `setting` messages (9.2), `ask.machine`, a `view.projects` notice |
| Reading back a write | a controller may call `replaceText()` and then `getText()`, expecting its own text (`updateBoardFile()` did; fixed) | the value it computed, or `update(edit)`, so a write that is still on its way is never read as if it had landed (5.5, 13.1) |
| Interfaces that are not plain data | done for the toast button (`ToastButton`: a label and a token; `AppSession` keeps the action, runs it once on `toastActivated(token)`, and forgets all but the latest 8), the token dialog's test (the dialog asks through `CollabDialogs.onTestToken`, which the controller sets), the Fields… dialog's counts (`SchemaDialogOptions.uses` is a list of `FieldUse`), and the settings (`AppFrontend.settings` is the core's store, not a member of the host). The document hooks and `logs.show` take ids. The harness card menu is plain entries with tokens (`HarnessMenuEntry`; `runMenu(token)` runs one, and a new menu forgets the tokens of the one before), and the core holds the board (`ViewController.currentBoard()`, from what it last sent the board view or the view reported, with `commitBoard`) instead of asking the view for it. The menus the views build for themselves (`MenuEntry` in `ui/kanban.ts`, `ui/inbox.ts`, `ui/filetree.ts`) are frontend code and stay closures | tokens, precomputed answers, arrays, core-owned state (4.4, 6.4, 7) |

Moving these is worth doing for the GTK app on its own: it is the same direction `AppSession` started, and each step is testable on Node.

### 13.1 Guards that keep the list from growing

The protocol is built later (section 15); what makes it cheap then is that the code it carries is already shaped for it. Three checks hold that shape now, each with a list of today's exceptions that may only shrink:

- **Views do not act** (`scripts/layers.mjs`, `UI_ACTS_ALLOWED`). A module in `ui/` may not import, for its values, a core module that reaches the runtime (one that imports `platform/index.ts`, directly or through others; `i18n.ts` does not count). Pure core modules and `import type` are fine. The list is empty: the Assistant's row removed `ui/chat.ts` → `agent/chatcontroller.ts`, the history's row `ui/history.ts` and `ui/historyviewer.ts` → `git.ts`, and the file tree's row `ui/filetree.ts` → `fileops.ts`, and the search's row the host that gave `ui/searchpanel.ts` the files and the write.
- **The frontend gets plain data** (`tests/unit/plaindata.ts`, `KNOWN`, checked by `tsc`). Every method of `AppFrontend` and `AppDialogs` takes and returns plain data (4.4), a Promise of it, or nothing; a field is plain data or a view checked the same way. A new member that takes a callback, a `Set`, a `Date`, or a live object fails the typecheck, and so does fixing one without removing it from `KNOWN`. The list is empty now: the document hooks (`attach`, `detach`, `activated`, `contentChanged`, `refreshTitle`, `setIcon`), `screen.showText`, and `logs.show` name a document or a run by its id, and the editor of a new document is made through `AppFrontend.createEditor(id)` (a replica in the core over the protocol, the widget under GTK). A `Set`, a `Date`, and an `Iterable` are gone: `setDiff` takes the commented lines as an array, `HomeData.now` is milliseconds since 1970, and `enableActions` takes an array of names.
- **Writes land later** (`LaggingEditor` in `tests/unit/appsession.ts`, on both runtimes). An editor whose writes land a turn later, the way they will over the protocol, and which throws when the text is read while a write is on its way, or when a whole text is written over one. Scenarios that drive `AppSession` with it catch a controller that reads back its own write (5.5). The first scenario, two board updates in one turn, found `updateBoardFile()`; more scenarios are added as the controllers of section 13 move. The Assistant's (`tests/unit/assistant.ts`) applies an approved edit to an open document, lets the agent read the file again in the same turn, and undoes it in a later one; it passed without a change, since `applyChangeBatch()` reads each file once before it writes. The history's (`tests/unit/history.ts`) discards the changes of a file open in an editor with typing that has landed: the controller saves, restores the file with git, and hands the editor the file's text through `update()`. It found that marking the document saved right after that write must wait behind it, as messages keep their order (4.3); `LaggingEditor.setModified` now does. Not covered yet: the rollback of a batch whose later write fails writes the earlier file's whole text again (`replaceText(before)`) while the first write may still be on its way; it should go through `update()`.

## 14. Module layout

```
src/app/protocol/
  messages.ts     the types of every message in this document (pure, no runtime)
  framing.ts      line reader and writer; shared with agent/daemon/ where it fits
  replica.ts      a document's text and version; applies edits; ProtocolEditor implements TextEditor
  frontend.ts     ProtocolFrontend implements AppFrontend by sending notices and asks
  server.ts       routes requests (commands, actions, answers) to AppSession
src/sidecar.ts    the Node entry point: platform/node, AppSession, stdio
```

`app/protocol/` follows the `app/` rules (no GI, no `ui/`); the layer check gets a rule that only `sidecar.ts` and tests construct it.

## 15. Plan

1. The prerequisites of section 13, one feature at a time, each with its test on Node. This step is worth doing for the GTK app on its own and does not commit Markwork to a second frontend.

The steps below start only when a second frontend is actually started (1.1):

2. `messages.ts`, `framing.ts`, and `replica.ts` with the replica fuzz test and the race scenarios (sections 10 and 12).
3. A first slice end to end: open a folder, open a board document, move a card, see the text change, save. A fake frontend in a test drives it, then a minimal web page over the sidecar shows it can be drawn.
4. The rest of the views and asks, one controller at a time, each checked against the GTK frontend's behaviour.
5. The first real frontend.

## 16. Open questions

- Undo across the line. A `doc.replace` with `undo: "step"` is one undo step in the editor, so undoing a card move is an editor undo, and the board follows through `doc.edit` and `view.notes`. That matches today's GTK behaviour; whether CodeMirror's history merges steps the same way needs checking in the first slice.
- Large documents. The whole text is sent on `doc.open`. A document of several megabytes is fine on a pipe; whether the core should also stop keeping a replica of documents it never reads (an image, a huge log) can wait for a measurement.
- Coalescing interval. 100 ms is a guess; the agent's context and autosave tolerate much more, but the word count in the status bar may want less. Measure in the first slice.
- How strict rebasing should be. Step 3 of 5.4 treats an adjacent edit as touching, so an agent line inserted right where the user is typing is refused rather than guessed. That is safe; whether it refuses too often (typing at the end of a list a run is also appending to) is for the first slice to measure.
- One window per core. Several windows would need document ownership per window, or one core serving several frontends; not needed yet.
