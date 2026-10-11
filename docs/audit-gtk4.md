# Markwork GTK4 audit — 5 October 2026

Markwork already uses the GTK4 runtime entirely: no GTK3/GDK3 imports, GtkSourceView 4,
or WebKit2GTK were found in the application code, tests, scripts, and dependencies.
However, the migration does not yet fully use the modern GTK4 patterns: some
deprecated APIs and adaptations of GTK3 patterns are still kept.

This audit does not change the application code. The check covered the dependencies and
bindings, imports, widgets, input, dialogs, coordinates, images, themes, overlays,
component cleanup, and the test runner. The APIs were matched against the local bindings
and the official GTK documentation. The Markdown and agent modules were examined in relation to
the runtime dependencies and UI callbacks; this is not a security audit or
a proof of the correctness of all the application's algorithms.

## Results of the check

- Environment: GTK 4.14.5, GJS 1.80.2, X11 through Xvfb 1280×800.
- `npm test`: the build/typecheck succeeded; **392 passed, 0 failed**, including the kanban
  mouse tests and the file tree. The whole log was read and checked; no
  GTK/GJS/GLib warnings, criticals, or stack traces were found in the full run.
- The first attempt inside the sandbox stopped at the fake HTTP server because the localhost
  socket was blocked. The full run outside the sandbox succeeded; it did not use the real
  DeepSeek API.
- An additional probe used a `/tmp` configuration, a fake provider/key store, and a delayed
  Mermaid callback. The probe reproduced the three component-closing gaps
  below. The probe log was finally clean; what was observed is a callback/timer
  after closing, not a crash that has been proven.
- Wayland, HiDPI, real portal dialogs, and other GTK versions have not been tested.
  `test:ui` was not run because the user did not ask for tests on a desktop that
  moves the pointer. The benchmark was not run because the runtime code did not
  change; this audit makes no claim of a performance improvement or regression.

## Behavior findings first

### 1. P2 — The kanban board does not clean up its timers when the window is closed

Location: `src/ui/kanban.ts:141`, `:163`, `:459`, `:526`;
`src/window.ts:845`.

`KanbanBoard` creates a render idle, a scroll-restore idle, and a 40 ms autoscroll
timeout, but provides no `destroy()`. `MainWindow.dispose()` does not
clean up the board either. When a drag is still active and the window is destroyed, the probe
showed `dragging === true` and four autoscroll calls within 180 ms
after closing. The GLib source keeps holding the board and keeps accessing widgets.

Add explicit cleanup: stop the drag, store/remove the idle IDs, set a
disposed marker, and call the cleanup from `MainWindow.dispose()`.
Tests for closing during a drag and while a render is still queued need to be added.

### 2. P2 — A Mermaid render result is still applied to a closed editor

Location: `src/editor/mermaid.ts:91`, `:195`.

`destroy()` stops the debounce and the slots, but the renderer result callback only
checks the code, the theme, and the membership of the block. The block stays in `this.blocks`
after the editor is closed, so that check passes. The delayed-callback probe
produced one `render()` call after closing.

Check `this.destroyed` in the callback and stop/invalidate the work per layer
without shutting down the shared renderer that other tabs still use. Test closing
a tab/window while WebKit is still rendering.

### 3. P2 — The chat and API key promises do not follow the panel's lifetime

Location: `src/ui/chat.ts:246`, `:305`, `:353`, `:533`.

`destroy()` cancels a request that already has a `Gio.Cancellable` and the
timers that already exist. However, `send()` waits for the key before creating the cancellable;
the result is still processed after the panel is closed. The probe held the key Promise,
closed the window, and then resolved it with `null`: `addNote()` was still called
once after closing. The streaming callbacks, `finally`, and the asynchronous key
operations also do not check the disposed status yet.

Add a disposed status/generation token, check it after every `await` and
before a callback accesses the UI, and prevent new timers from being created after
cleanup. Cancelling the network itself does not cancel the continuation of the Promise.

### 4. P2 — The minimum GTK version requirement is not clear

Location: `src/ui/theme.ts:121`, `src/ui/dialogs.ts:35`,
`src/editor/view.ts:567`, `README.md:28`.

The documentation mentions GTK4 and the tested version, but does not give a firm
minimum or a version check at startup. `load_from_string()` only exists
since GTK 4.12 and is called when the initial theme is installed. So the application currently
needs **at least GTK 4.12**; installing only GTK4 version 4.8/4.10 is not
enough. `FileDialog` and `UriLauncher` also need 4.10.

State the supported minimum, add a clear startup message or a compatibility path
if older versions are really meant to be supported. Newer TypeScript bindings
do not guarantee that the symbol exists on the user's machine.
[`load_from_string` documentation](https://docs.gtk.org/gtk4/method.CssProvider.load_from_string.html).

## GTK4 modernization

| Part | Current state | Suggested fix |
| --- | --- | --- |
| ~~File tree~~ (done: now `Gio.ListStore` + `TreeListModel` + `ListView`) | `TreeStore`, `TreeView`, `TreeViewColumn`, `CellRendererPixbuf/Text`; this family has been deprecated since 4.10 | `Gio.ListStore` + `Gtk.TreeListModel`, a selection model, `Gtk.ListView`, `Gtk.TreeExpander`, and a widget factory. Keep lazy loading, folder monitoring, reveal, menus, and DnD. |
| Model picker (`src/ui/chat.ts:143`) | `Gtk.ComboBoxText`, deprecated since 4.10 | `Gtk.DropDown` + `Gtk.StringList`, with a mapping from the index to the model ID. |
| Dialogs (`src/gtkutil.ts:52`, `src/ui/dialogs.ts:35,78`) | The widgets are GTK4, but `runModal()` returns a blocking pattern through a nested `GLib.MainLoop` | Change the interface to Promise/callback and make the open/save/close flows asynchronous. A custom modal form window can still be used; it is not required to move to `AlertDialog`, which has documented problems in the project environment. |
| Images (`src/editor/images.ts:256`, `src/editor/mermaid.ts:323`) | `Gtk.Picture.new_for_pixbuf`, deprecated since 4.12; a resize makes a new pixbuf | Use `Picture` with a `Gdk.Paintable/Texture`, cache the conversion result, and measure the resize/HiDPI path before changing the scaling strategy. For the 4.14 target, a texture from a pixbuf can be a transition stage; that conversion API itself is deprecated since 4.20. |
| Kanban coordinates (`src/ui/kanban.ts:465–545`) | `translate_coordinates`, `get_allocated_width/height`, deprecated since 4.12 | `compute_point`, `get_width/get_height`; check the success boolean of the conversion. Do not replace the getters mechanically without checking the margins and the coordinate system. |
| Tab position (`src/ui/tabbar.ts:102`) | `get_allocation`, deprecated since 4.12 | `compute_bounds` against the scroller contents and the matching size getters. |
| Chat visibility (`src/ui/chat.ts:292` and similar calls) | `Gtk.Widget.show()/hide()`, deprecated since 4.10 | `set_visible(true/false)`. The `show()` method of the application class that calls `Window.present()` is not part of this problem. |
| Theme (`src/ui/theme.ts:36,114`) | Dark detection from the theme name, only at startup; the GTK dark preference is deprecated since 4.20 | Take the real system preference and listen for its changes while the user's choice is still `null`. Adjust the theme API to the supported version range. |

API status: [TreeView](https://docs.gtk.org/gtk4/class.TreeView.html),
[ComboBoxText](https://docs.gtk.org/gtk4/class.ComboBoxText.html),
[the asynchronous dialog guide](https://docs.gtk.org/gtk4/migrating-3to4.html#stop-using-blocking-dialog-functions),
[Picture from a pixbuf](https://docs.gtk.org/gtk4/ctor.Picture.new_for_pixbuf.html),
[Texture from a pixbuf](https://docs.gtk.org/gdk4/ctor.Texture.new_for_pixbuf.html),
[coordinates](https://docs.gtk.org/gtk4/method.Widget.translate_coordinates.html),
[allocation](https://docs.gtk.org/gtk4/method.Widget.get_allocation.html),
[visibility](https://docs.gtk.org/gtk4/method.Widget.show.html),
[the theme preference](https://docs.gtk.org/gtk4/property.Settings.gtk-application-prefer-dark-theme.html).

Deprecated means it is still a GTK4 API that works on the tested version,
but not the recommended direction of development. It does not prove that the application
still loads GTK3. Modernizing `TreeView` is bigger than replacing
`ComboBoxText` and should be done as a separate change.

## Additional fixes

- `src/editor/images.ts:87–92`: reading the file is already async, but the decoding
  `Pixbuf.new_from_stream()` and the orientation run synchronously on the main thread.
  `scale_simple()` is also synchronous on resize. A large photo can hold up the UI;
  use async decoding and measure the large-image scenario before claiming
  a performance improvement. The global image cache has no limit or invalidation
  when the file changes; consider a memory limit and reloading.
- `src/ui/dialogs.ts:57–59`: all file picker errors are treated as a cancellation.
  Distinguish dismissed/cancelled from a portal/I/O failure, and show an error
  that can be acted on. A non-local `Gio.File` choice also yields
  `get_path() === null`; support URIs or give a clear explanation.
- `src/editor/overlays.ts:37–74`: the connections to the old adjustment are not disconnected when
  the adjustment is replaced or when the slot is stopped. Store the connection IDs,
  disconnect, and check disposed before a direct allocation. This is a static finding;
  a special probe for replacing the adjustment has not been done.
- `src/ui/history.ts:210–222`, `src/window.ts:515–535,575–588`: some of the continuations of
  commit/autosave and the idle reload of the board also do not use a closing guard yet.
  The lifecycle check needs to cover all the operations, not only the main timers.
- `src/ui/imageviewer.ts:225`: using Cairo through `DrawingArea.set_draw_func`
  is legitimate in GTK4. The helper `Gdk.cairo_set_source_pixbuf` is only deprecated since 4.20;
  this modernization has a lower priority for the 4.14 target.
  [Documentation of the Cairo helper](https://docs.gtk.org/gdk4/func.cairo_set_source_pixbuf.html).

## What is already right

- `Gtk.Application`, `ApplicationWindow`, `GtkSource.View/Buffer` version 5,
  `append/set_child`, `GestureClick/Drag`, the keyboard/motion/scroll controllers,
  `DragSource/DropTarget`, `Gio.SimpleAction` actions, and `PopoverMenu` are already GTK4.
- `HeaderBar.pack_start/pack_end` is still a legitimate GTK4 API; it is not a leftover of
  GTK3 `Gtk.Box.pack_start`. A search by method name alone can be wrong.
- `GdkPixbuf` version 2.0, Soup version 3.0, and Cairo do not mean GTK3.
  WebKitGTK 6.0 is the GTK4 path; its dynamic loading is correct.
- `StyleContext.add_provider_for_display()` is a CSS installation API
  that is still valid, even though many `StyleContext` instance APIs are deprecated.
- The line iterators, child traversal, panel expansion, overlay position after scrolling,
  and highlight scheduling are already adapted to GTK4 and have tests.
- The overlay slot pool and the tiny markers are workarounds that the project
  explains. Keep them for now; reevaluate only with a reproduction of the GTK problem
  and a measurement on the targeted version.

## Order of work

1. Close the lifecycle gaps of kanban, Mermaid, and chat together with their regression tests.
2. State the GTK minimum and the handling of dialog errors.
3. Modernize `ComboBoxText`, visibility, and coordinates.
4. Migrate the file tree to the modern GTK4 models/widgets.
5. Change the dialog contract to async, then optimize images and the theme integration.
6. Add verification for Wayland, HiDPI, portals, and the supported GTK versions.

The next runtime changes need to follow the tests, the visual checks, and the
benchmark that the project guide requires. The results of this audit do not replace
those checks.
