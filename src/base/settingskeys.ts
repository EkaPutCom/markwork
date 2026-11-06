// The keys of the app's settings: their type, their default, and for a key that
// takes one of a few values, those values.
// The store (platform/node/settings.ts) refuses a key that is not here;
// AppSettings (settings.ts) gives them typed names.
//
// The types: 'b' boolean, 's' string, 'i' and 'x' integer, 'u' integer ≥ 0,
// 'a(si)' and 'a(sx)' a list of
// [string, integer], 'a{ss}' an object of strings.

import type { SettingSpec } from '../platform/index';

export const SETTING_KEYS = {
    'color-scheme': {
        type: 's',
        default: 'system',
        choices: ['system', 'light', 'dark'],
    }, // system follows the system theme
    // autosave documents that already have a file
    autosave: { type: 'b', default: true },
    typewriter: { type: 'b', default: false },
    focus: { type: 'b', default: false },
    // the editor hides Markdown syntax on the cursor line too
    visual: { type: 'b', default: true },

    sidebar: { type: 'b', default: true }, // sidebar open
    'sidebar-page': {
        type: 's',
        default: 'files',
        choices: ['files', 'search', 'history', 'collab'],
    },
    // Side-panel width in pixels (the window keeps it between 200 and 480).
    'sidebar-width': { type: 'u', default: 280 },
    // Folded Files-view sections and their sizes (JSON written by the window).
    'sidebar-sections': { type: 's', default: '' },
    // The Files Timeline shows history for the open file.
    'timeline-open': { type: 'b', default: false },
    chat: { type: 'b', default: false }, // assistant panel open
    'chat-model': { type: 's', default: 'deepseek-flash' },
    // model thinking mode (more thorough, slower)
    'chat-thinking': { type: 'b', default: false },
    // agent UUID → selected local background root; never prompts or credentials
    'folder-background': { type: 'a{ss}', default: {} },
    // save conversation history in folder/.markwork/chats
    'chat-save': { type: 'b', default: true },

    // how often to look for new pull requests (Preferences offers 30 to 3600)
    'forge-poll-seconds': { type: 'u', default: 60 },
    // a desktop notification for a new or updated pull request
    'forge-notify': { type: 'b', default: true },

    folder: { type: 's', default: '' }, // last opened folder, '' = none
    // file-backed tabs to restore: [path, cursor in code points]
    tabs: { type: 'a(si)', default: [] },
    'active-tab': { type: 'i', default: -1 }, // index in tabs, -1 = none
    home: { type: 'b', default: true }, // show Home when no document is open
    // [path, Unix seconds], newest first
    'recent-files': { type: 'a(sx)', default: [] },
    // project name → folder, for external harnesses on kanban cards
    projects: { type: 'a{ss}', default: {} },
    // How the cards of a project are isolated: the project ("machine:project"
    // on another machine) → a JSON object with
    // worktrees (true/false), slots, base, dir, and afterMerge; a missing
    // project gets a worktree per card.
    'project-options': { type: 'a{ss}', default: {} },
    // Where external harnesses run: '' = as children of this window, 'local' =
    // the markworkd daemon on this computer,
    // otherwise the name of a machine in machines.
    'harness-machine': { type: 's', default: '' },
    // machine name → SSH target (a host from ~/.ssh/config, or user@host)
    machines: { type: 'a{ss}', default: {} },
    // "machine:project" → the project's folder on that machine
    'machine-projects': { type: 'a{ss}', default: {} },
    // markworkd on remote machines when not on the PATH; '' = markworkd
    'daemon-command': { type: 's', default: '' },
    // The missing programs the user hid from Home's Set up section
    // (ProgramsController.hideSetup); it shows again when
    // that list changes.
    'setup-hidden': { type: 's', default: '' },

    width: { type: 'i', default: 1100 }, // window size
    height: { type: 'i', default: 760 },
    // the sample document has been shown before
    welcomed: { type: 'b', default: false },
} satisfies Record<string, SettingSpec>;
