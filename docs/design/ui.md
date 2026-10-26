# UI rules

The design system of the Markwork window (`electron/renderer/`), written for whoever adds or changes UI there, agents first. Plan: [`design-system.md`](design-system.md). Measurements and the reasons behind the decisions: [`ui-inventaris.md`](ui-inventaris.md). Visual reference: the mockups in [`shadcn/`](shadcn/).

Precedence: what the user asks for, then this file, then the mockups. The look stays as it is (shadcn/ui "new-york", zinc, Geist); do not restyle it toward another app.

## Status

The code follows this file everywhere (since 26 October 2026, stage 7 of [`design-system.md`](design-system.md)), and the guard holds every file to it with no exceptions but `ui-allow`. Where a rule names something that does not exist yet, add it the way this file describes.

| Part | State |
| --- | --- |
| Theme tokens of shadcn, `--success`, `--warning`, `--chart-*` | In `globals.css` |
| Primitives in [Primitives](#primitives), with Tooltip and `IconButton` | In `ui/`. Need another one: add it to `ui/` (shadcn CLI, or by hand in the same shape) |
| Text sizes `text-2xs` and `text-ui`, the tokens of this file | In `globals.css` |
| Layer and motion tokens (`--z-*`, `--duration-*`) | In `globals.css`; `theme.css` uses them |
| `domButton` and the other helpers for widgets without React | In `ui/dom.ts`; every widget in `lib/` builds its controls with them |
| The classes in `theme.css` that imitate a primitive (`.button`, `.flat`, `.entry`, …) | Gone: from `theme.css`, the components, and the widgets of `lib/` |
| The guard in `npm test` (`scripts/ui.mjs`) | In `npm run typecheck` and `npm run test:core:node`; strict, every file clean |

## Where things live

| What | Where |
| --- | --- |
| Color tokens, fonts, radius, text sizes | `electron/renderer/styles/globals.css` (only file with color values) |
| Primitives (shadcn/ui and Markwork's own, such as `IconButton`) | `electron/renderer/ui/` |
| Feature components | `electron/renderer/components/` |
| Icons | `electron/renderer/components/Icons.tsx` (`Icon`, `iconElement`) |
| Layout that is Markwork's own, editor and CodeMirror styles | `electron/renderer/styles/theme.css` |
| Editor widgets that build DOM without React | `electron/renderer/lib/` |
| `cn()` | `electron/renderer/lib/utils.ts` |

## Color

Every color is a token. A component, a `theme.css` rule, or a widget never writes a color value (`#…`, `rgb()`, `oklch()`, a named color); it uses a Tailwind class built from a token (`bg-muted`, `text-muted-foreground`) or `var(--token)`.

### Surfaces and text

| Role | Token |
| --- | --- |
| Window, editor, pane | `background` / `foreground` |
| Sidebar and activity bar | `sidebar`, `sidebar-foreground`, `sidebar-accent` (the selected row), `sidebar-border` |
| Card (board card, proposal, dialog body) | `card` / `card-foreground` |
| Menu, popover, tooltip, toast | `popover` / `popover-foreground` |
| Secondary text: meta, counts, hints, placeholders | `muted-foreground` |
| Quiet filled area: code background, a board column, a section head | `muted` |
| Hover and pressed state of a ghost control or row | `accent` / `accent-foreground` |
| Primary action | `primary` / `primary-foreground` |
| Lines and control borders | `border`, `input` |
| Focus ring | `ring` (through the primitives' `focus-visible` styles) |

### Meaning

| Meaning | Token | Rule |
| --- | --- | --- |
| Error, destructive action | `destructive` | Always with words: "Delete note", "Could not save" |
| Done, applied, saved | `success` | Always with words |
| Waiting, needs attention | `warning` | Always with words |

A state is never told by color alone: it has text, or an accessible name when only an icon shows (see [Status](#status-1)).

### Categories

One palette of eight named colors for anything the user tells apart by color: field options, tags, gallery covers, chart slices, avatars.

- Tokens: `--cat-red`, `--cat-amber`, `--cat-green`, `--cat-blue`, `--cat-purple`, `--cat-teal`, `--cat-pink`, `--cat-gray`. The names are those of `OPTION_COLORS` in `src/markdown/fields.ts`, which a document stores (`option:color`); they never change.
- Text or an icon on a category color: `--on-cat`. A chart slice with no value: `--cat-none`.
- A color picked by index (tags, covers from `tagColor`/`tagColorIndex`) maps to the names in this order: green, blue, purple, red, pink, teal, amber, gray. Avatars use the first six.
- A large field of a category color (a gallery cover) is softened toward the page: `color-mix(in oklab, var(--cat-…) 70%, var(--background))`. Dots, chips, slices and avatars take the color as it is.
- No other categorical palette, in CSS or in TypeScript.

### Editor and other families

| Family | Tokens | For |
| --- | --- | --- |
| Document text | `--heading`, `--link`, `--quote-fg`, `--code-bg`, `--code-fg`, `--faint`, `--sel` | Editor content |
| Code syntax | `--tok-keyword`, `--tok-string`, `--tok-number`, `--tok-comment`, `--tok-name`, `--tok-type`, `--tok-op` | Fenced code with a language |
| Git conflicts | `--cf-current`, `--cf-current-head`, `--cf-incoming`, `--cf-incoming-head`, `--cf-neutral` | Conflict blocks |
| Search hits and `==mark==` | `--highlight`, `--highlight-strong` (the current hit) | Editor, Search panel, CSV |
| Darkening over content | `--overlay` (behind a dialog), `--scrim` (behind the image viewer, over a bar), `--scrim-strong` (a control over a picture) | Backdrops, controls on images |
| Text on a solid color of meaning | `--destructive-foreground`, `--success-foreground`, `--on-cat` | A late chip, a done bar, an avatar |
| Fixed grounds | `--canvas-dark` (the image viewer), `--html-page` (an HTML page, white in both themes) | |
| Board column | `--column-bg` | Board lists |
| Editor Inspector | `--inspect-widget`, `--inspect-prefix`, `--inspect-caret` | Dev mode only |

### A new color

A new color is a new token in `globals.css` with a light value in `:root` and the same dark value in both the `prefers-color-scheme: dark` block and the `[data-theme="dark"]` block, plus a `--color-*` line in `@theme inline` when Tailwind classes should reach it. Check it in both themes. Prefer an existing token; a new one needs a role that none of the above has.

## Type

- **Fonts:** `font-sans` (Geist) for the UI, `font-mono` (Geist Mono) for code, paths, shortcuts, numbers in a grid, and source mode.
- **Sizes:** only these seven.

| Class | Size | For |
| --- | --- | --- |
| `text-2xs` | 11px | Small capitals labels (a section head), counts, meta under a row |
| `text-xs` | 12px | Secondary text, badges, captions, hints |
| `text-ui` | 13px | Dense UI: document tabs, tree and list rows, menu items, cells |
| `text-sm` | 14px | Normal UI: buttons, forms, dialog text (the body default) |
| `text-base` | 16px | Small headings |
| `text-lg` | 18px | Dialog and page titles |
| `text-2xl` | 24px | Large titles (Home, Welcome) |

- No `text-[…px]` and no `font-size` in px outside `globals.css`. A rule in `theme.css` takes the size from the scale's variable: `font-size: var(--text-xs)`.
- **Weights:** `font-normal` for text, `font-medium` for controls and row labels, `font-semibold` for titles and headings. `font-bold` only for H1 in the editor.
- A small capitals label: `text-2xs font-semibold uppercase tracking-wider text-muted-foreground`, as the Files view's section heads.
- Digits that line up (counts, sizes, line numbers, a table of numbers): `tabular-nums`.
- **The editor's content is not on this scale.** Its sizes are `em` of the editor font so they follow zoom: H1 2.25em, H2 1.5em, H3 1.25em, H4–H6 1em with weight only.

## Spacing, size, radius

- **Spacing** is Tailwind's scale on 2px and 4px steps: `0.5` (2px), `1` (4px), `1.5` (6px), `2` (8px), `3` (12px), `4` (16px), `6` (24px). Gap between items in a row: `gap-1.5` or `gap-2`. Inside a panel or dialog: `p-3` or `p-4`. Between sections: `gap-4` or `gap-6`. No 10px or 14px.
- Lay out siblings with flex or grid and `gap`, not margins on each child.
- **Heights of controls** are the primitives' sizes: Button `default` h-9, `sm` h-8, `xs` h-7; icon buttons `icon` 36px, `icon-sm` 32px, `icon-xs` 28px. Dense bars (pane bar, format bar, tree) use `sm` or `xs`; dialogs and forms use `default`.
- **Radius:** `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl` (all from `--radius`) and `rounded-full`. Inside `ui/` the primitives keep shadcn's own small values (a check box's `rounded-[4px]`). Controls `rounded-md`, cards and dialogs `rounded-lg` or `rounded-xl`, dots and avatars `rounded-full`. No radius in px.
- **Shadows:** Tailwind's `shadow-xs` to `shadow-2xl` only, for things that float (menus, popovers, a floating panel, a dragged card); in `theme.css` as `var(--shadow-md)`.

## Layers

What floats over the content takes its place from a token of `globals.css`, bottom to top:

| Token | Value | For |
| --- | --- | --- |
| `--z-float-backdrop` | 10 | The darkening behind a floating sidebar or Assistant |
| `--z-float` | 20 | A sidebar or the Assistant floating over the editor in a narrow window |
| `--z-hint` | 30 | A hint or a small popup tied to a panel (the block hint, the Assistant's popover, the Inspector's flash) |
| `--z-viewer` | 35 | A viewer over the whole window (the image viewer) |
| `--z-screen` | 40 | A screen over the window (the UI Gallery) |
| `--z-overlay` | 50 | Dialogs, menus, popovers, the palette: the primitives' own `z-50` is this layer |
| `--z-toast` | 60 | The toast, over everything |

- In `theme.css`: `z-index: var(--z-overlay)`. In a class: `z-(--z-overlay)`.
- A number from 1 to 9 only orders siblings inside one component (a sticky header row over its cells, a grip over a sash). It never lifts something over another component.
- A new layer is a new token here, between the two it goes between, not a number picked to win.
- Inside `ui/` the primitives keep shadcn's `z-50` and `z-10`.

## Motion

- A change of state (hover, open, a fold, a move) takes `--duration-fast` (100ms: a hover, a chevron, a small move), `--duration-normal` (150ms: a switch, a color), or `--duration-slow` (200ms: a dialog or a panel coming in). In `theme.css`: `transition: opacity var(--duration-fast)`. In a class: `transition-colors` (it takes `--duration-normal`) or `duration-(--duration-fast)`.
- The default easing; no `cubic-bezier` of a feature's own.
- Motion shows what changed; it never delays work. Nothing animates on every keystroke or while a list scrolls.
- When the system asks for less motion (`prefers-reduced-motion`), the three tokens are 0ms, so whatever uses them stops moving. A loop that tells the user something runs (a spinner, a blinking caret) is an `animation` with `infinite` and keeps its own duration; it slows down rather than stops.
- Inside `ui/` the primitives keep shadcn's own animations (`animate-in`, `duration-200`).

## Icons

- Through `Icon` (`<Icon name="search" />`) or, in a widget without React, `iconElement(name)`. Both are in `Icons.tsx`, named by what the icon stands for.
- A new icon: import it from Lucide in `Icons.tsx` and give it a name there. A component never imports `lucide` itself.
- Size 16 by default; 14 in dense rows; the primitives size an SVG inside them.
- An icon next to text is decoration (`aria-hidden`). An icon alone needs a name: `IconButton` gives it one.

## Primitives

Use a primitive from `ui/` for every control. A raw `<button>`, `<input>`, `<select>`, or `<textarea>` is written only inside `ui/`.

| Need | Primitive | Notes |
| --- | --- | --- |
| An action | `Button` | `default` for the one main action of a view or dialog; `outline` for other actions; `ghost` in toolbars, bars and rows; `destructive` for the confirm of a delete; `link` for an inline action in text |
| An action shown as an icon only | `IconButton` | Takes `label` (required) and `shortcut`; sets `aria-label` and the Tooltip |
| One of several, joined | `ToggleGroup` | Layout choices, Aa / ab / .* in Search |
| A small label, a tag, an option | `Badge` | `secondary` by default; `outline` with a `--cat-*` dot for a tag or an option |
| A shortcut shown | `Kbd` | In menus, tooltips, the palette |
| Text entry | `Input`, `Textarea`, with `Label` | `InputGroup` when an icon or a button sits inside (a search entry) |
| On / off | `Switch` for a setting that applies at once; `Checkbox` for an item in a list or a form that is submitted | |
| One of a few, all visible | `RadioGroup` | |
| One of many | `Select` | |
| Pages inside a dialog or panel | `Tabs` | Not for document tabs (see below) |
| A menu from a button | `DropdownMenu` | |
| A menu from a right click | `ContextMenu` | |
| The window's menu bar | `Menubar` | |
| A small form or details next to its trigger | `Popover` | |
| A task in its own window (Preferences, a form) | `Dialog` | |
| A question that must be answered (discard, delete, overwrite) | `AlertDialog` | Buttons say the verb: "Discard changes", not "OK" |
| A name or shortcut on hover and focus | `Tooltip` | Through `IconButton` in most cases |
| A short notice that goes away | Toast: shadcn's Sonner (`ui/sonner.tsx`), shown from the store's `toast` by `App.tsx` | Never the only place an error is told when the user must act on it |
| Search through commands or items | `Command` | The palette and the `/` menu |
| A block that stands apart (board card, proposal) | `Card` | Not for every section: a section is a heading and a gap |
| A section that folds | `Collapsible` | Files view sections |
| Something running | `Spinner` with words ("Sending…") | |
| A line between groups | `Separator` | |

Markwork's own, not shadcn: document tabs and panes (drag, split, drop zones), the activity bar, the Files tree, the CSV grid, the timeline, the calendar, the diff, the Editor Inspector. They keep their own components and `theme.css` rules, built from the tokens and scales of this file and from the primitives for the controls inside them.

A primitive that is missing: add it to `ui/` with the shadcn CLI (`components.json` names the folders) or by hand in the same shape (`data-slot`, `cn()`, variants with `cva`). A primitive of Markwork's own (such as `IconButton`) goes in `ui/` too and is built from the shadcn ones.

## Patterns

### Status

- A state is said in words, in the same place each time: the Saved / Unsaved badge in the header, a program's state on the Programs page, a run's state on its card.
- Color follows the words (`success`, `warning`, `destructive`); it never replaces them.
- A state that changes by itself has `role="status"` so a screen reader hears it.

### Empty

- An empty list or panel says what would be there and, when there is one, how to add the first: "No headings in this document.", "No notes yet. Add one with + New note."
- `text-sm text-muted-foreground`, centered in a panel, at the start in a list.

### Errors

- An error says what went wrong and what to do: "Could not push: the remote has new commits. Pull, then push again."
- In a form: under the field, `text-xs text-destructive`, `role="alert"`, and `aria-invalid` on the field. Never in a `title`.
- Of an action the user started outside a form: a toast with the words, and the state stays visible where the action was (the button, the row).

### Asking

- Before something that cannot be undone or loses work: `AlertDialog`. Something the Trash or Undo brings back does not need one.
- The confirming button names the action and is `destructive` when it removes something.

### Working

- `Spinner` and a word ("Loading…", "Sending…") where the result will appear. A button that started it is disabled until it ends.

### Keyboard and names

- Every function is reachable with the keyboard; focus is visible (the primitives' `focus-visible` ring).
- Every control has a role and an accessible name. The Electron tests find elements by role and name, so a control without one is also one no test can reach.

### Narrow window

- At 900px and narrower the Assistant floats; at 600px and narrower the side panel too (`layoutOf` in `lib/client.ts`). The header gives way in its set order so the document name stays readable.
- A new part of the window is checked at a narrow width as well as at full width.

## Tooltip and `title`

| Case | Rule |
| --- | --- |
| A button that is only an icon | `IconButton` with `label` (and `shortcut` when there is one) |
| A button with text | No `title`. If the text is not clear, change the text, or add a visible description |
| A shortcut hint | `Tooltip` with `Kbd`: `IconButton shortcut=…`, or a `Tooltip` around a text button |
| Text that is cut off (a file name, a title, a path) | A `title` with the full value is fine |
| An error | Never in a `title`; see [Errors](#errors) |

A widget without React (see [Widgets without React](#widgets-without-react)) has no Tooltip: its icon button carries the name as `aria-label` and `title`, which `domButton` sets.

## The editor's content

- Styles of the document are in `theme.css`, under `.cm-editor` and `.cm-md-*` (the names come from `SyntaxName` in `src/markdown/highlight.ts`). They use the document-text, syntax, conflict, and highlight tokens above, and sizes in `em`.
- The editor's own look (line height, the width of the text column, the gaps around headings and code boxes) is set once there; a feature does not restyle it.
- A widget's vertical spacing is padding or a transparent border, not a margin: CodeMirror does not count a widget's margin, and a click below it lands on the wrong line.
- Widgets in `lib/` build DOM without React, so they cannot use the primitives. See [Widgets without React](#widgets-without-react).
- A change to the editor's look is checked with `tests/samples/all-formats.md` in both themes and in visual and source mode.

## Widgets without React

The editor's widgets and panels in `lib/` (the find bar, the block handle and tools, the selection menu, the link editor, the task box, the conflict bar) build their DOM with `document.createElement`, so they cannot render a React primitive. They take the primitive's look from the same source:

- A button is made with `domButton` from `ui/dom.ts`: the classes of `buttonVariants`, `type="button"`, and for an icon only its `aria-label` and `title`. It keeps the editor's focus and selection while pressed, unless `keepFocus: false`.

  ```ts
  domButton({ label: 'Close', content: iconElement('window-close'), size: 'icon-sm', onClick: () => this.close() })
  ```
- The other controls in `ui/dom.ts`, each from its React primitive's classes: `domInput` (an Input; `inGroup` for the entry of a group), `domInputGroup` and `domInputGroupAddon`, `domToggle` (its state in `aria-pressed`, read and set with `isPressed` and `setPressed`), `domCheckbox` (a button with role checkbox, as Radix draws it; `setChecked` turns it), and `domKbd`.
- A control that has none yet gets a function of its own there, built the same way. Move the primitive's classes into a `cva` or a constant that both use (`inputClasses`, `checkboxClasses`, `kbdClasses`), so the two never drift.
- A badge takes `badgeVariants(…)` as its `className`.
- Icons come from `iconElement`, never an SVG written as a string.
- A widget never writes its own button, field, or badge CSS in `theme.css`; it writes only its layout there (where the bar sits, the gap between its parts).
- `document.createElement('button' | 'input' | 'select' | 'textarea')` is written only in `ui/`.

## `theme.css`

- New rules go there only for Markwork's own layout (see the end of [Primitives](#primitives)) and the editor. Nothing that looks like a primitive: use the primitive.
- No class from the old set (`.button`, `.flat`, `.suggested`, `.circular`, `.icon-button`, `.entry`, `.chip`, `.popover`, `.dialog`, `.check`, `.radio`, `.switch`); they are gone, and the guard fails on one.
- A bare element is styled only inside `@layer base`, so it never overrides a Tailwind class on a primitive.
- It stays outside the CSS layers, so it wins over CodeMirror's defaults.

## Inline `style`

`style={{…}}` only for values computed at run time: a position, a size from a drag, a width from data, a transform. A constant goes in a class. Indentation by depth sets a custom property and lets the class compute the padding:

```tsx
<li className="tree-row" style={{ '--depth': depth } as CSSProperties}>
```

```css
.tree-row { padding-left: calc(10px + var(--depth) * 20px); }
```

## What the guard checks

`scripts/ui.mjs` runs in `npm run typecheck` and `npm run test:core:node` (so in `npm test` and CI) and fails on:

- a color value outside `globals.css`: `#…`, a color function, a named color in CSS, or a Tailwind palette class (`text-white`, `bg-red-500`)
- a raw `<button>`, `<input>`, `<select>`, or `<textarea>` outside `ui/`, in JSX or made with `document.createElement`
- a `z-index` of 10 or more that is not a token, or a `z-10` … `z-[…]` class of 10 or more outside `ui/`
- a `transition` or `animation` with a time that is not a token (a loop with `infinite` keeps its own), a `cubic-bezier`, or a `duration-…`, `delay-…` or `ease-[…]` class outside `ui/`
- a `font-size` or `font` in px, or a `text-[…px]` class, outside `globals.css`
- a `style={{…}}` whose values are all constants
- a button of an icon size that is not an `IconButton`
- a class from the old set (see [`theme.css`](#themecss)), in JSX or set by a widget in `lib/`

Every file must have none of these; there is no baseline.

| Command | Does |
| --- | --- |
| `npm run ui` | Check |
| `npm run ui -- --list <part of a path>` | List every finding in the matching files, with its line (`--list ''` for all) |

A line that breaks a rule on purpose (a color a library needs as a value, an `<input type="file">` that stays hidden) says why in a comment on that line or the one above: `ui-allow: <reason>`. The guard skips it.

## Checking a change

As `AGENT.md` asks for every change of appearance: a real screenshot in the light and the dark theme and in a narrow window, looked at before the work is called finished and shown to the user.

The UI Gallery shows every primitive of `ui/` in its states, the text sizes, the color tokens and the patterns of this file in one screen, with a Light / Dark switch. It is there in dev mode only (`npm start`, or `MARKWORK_DEV=1`): `Ctrl+Alt+G` opens and closes it (`components/UiGallery.tsx`). A change to a primitive or a token is checked there; a new primitive gets a row there in the same change, and `tests/electron/ui-gallery.mjs` names its section. Its Open Sample Document button opens a copy of `tests/samples/ui-gallery.md`, which has every element of the editor's content once, for a change to the editor's look.
