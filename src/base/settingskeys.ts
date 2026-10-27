// The keys of the app's settings: their type, their default, and for a key that takes one of a few values, those values.
// The store (platform/node/settings.ts) refuses a key that is not here; AppSettings (settings.ts) gives them typed names.
//
// The types: 'b' boolean, 's' string, 'i' and 'x' integer, 'u' integer ≥ 0, 'a(si)' and 'a(sx)' a list of
// [string, integer], 'a{ss}' an object of strings.

import type { SettingSpec } from '../platform/index';

export const SETTING_KEYS = {
    'color-scheme': { type: 's', default: 'system', choices: ['system', 'light', 'dark'] },   // system follows the system theme
    autosave: { type: 'b', default: true },             // autosave documents that already have a file
    typewriter: { type: 'b', default: false },
    focus: { type: 'b', default: false },
    visual: { type: 'b', default: true },               // the editor hides Markdown syntax on the cursor line too

    sidebar: { type: 'b', default: true },              // sidebar open
    'sidebar-page': { type: 's', default: 'files', choices: ['files', 'search', 'history', 'collab'] },
    'sidebar-width': { type: 'u', default: 280 },       // the side panel's width in pixels (the window keeps it between 200 and 480)
    'sidebar-sections': { type: 's', default: '' },     // the sections of the Files view that are folded or hidden, and their sizes (JSON the window writes)
    'timeline-open': { type: 'b', default: false },     // the Files view shows its Timeline section: the history of the open file is read
    chat: { type: 'b', default: false },                // assistant panel open
    'chat-model': { type: 's', default: 'deepseek-flash' },
    'chat-thinking': { type: 'b', default: false },     // model thinking mode (more thorough, slower)
    'chat-save': { type: 'b', default: true },          // save conversation history in folder/.markwork/chats

    'forge-poll-seconds': { type: 'u', default: 60 },   // how often to look for new pull requests (Preferences offers 30 to 3600)
    'forge-notify': { type: 'b', default: true },       // a desktop notification for a new or updated pull request

    folder: { type: 's', default: '' },                 // last opened folder, '' = none
    tabs: { type: 'a(si)', default: [] },               // file-backed tabs to restore: [path, cursor in code points]
    'active-tab': { type: 'i', default: -1 },           // index in tabs, -1 = none
    home: { type: 'b', default: true },                 // show Home when no document is open
    'recent-files': { type: 'a(sx)', default: [] },     // [path, Unix seconds], newest first
    projects: { type: 'a{ss}', default: {} },           // project name → folder, for external harnesses on kanban cards
    // How the cards of a project are isolated: the project ("machine:project" on another machine) → a JSON object with
    // worktrees (true/false), slots, base, dir, and afterMerge; a missing project gets a worktree per card.
    'project-options': { type: 'a{ss}', default: {} },
    // Where external harnesses run: '' = as children of this window, 'local' = the markworkd daemon on this computer,
    // otherwise the name of a machine in machines.
    'harness-machine': { type: 's', default: '' },
    machines: { type: 'a{ss}', default: {} },           // machine name → SSH target (a host from ~/.ssh/config, or user@host)
    'machine-projects': { type: 'a{ss}', default: {} }, // "machine:project" → the project's folder on that machine
    'daemon-command': { type: 's', default: '' },       // markworkd on remote machines when not on the PATH; '' = markworkd
    // The missing programs the user hid from Home's Set up section (ProgramsController.hideSetup); it shows again when
    // that list changes.
    'setup-hidden': { type: 's', default: '' },

    width: { type: 'i', default: 1100 },                // window size
    height: { type: 'i', default: 760 },
    welcomed: { type: 'b', default: false },            // the sample document has been shown before
} satisfies Record<string, SettingSpec>;
