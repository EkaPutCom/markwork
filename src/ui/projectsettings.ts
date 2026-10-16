// Preferences → Agents → Projects: the projects the agents work on (on the machine they run on), and for each one a
// page with how its cards are isolated (a worktree per card, how many at a time, the base branch, where the worktrees
// go, what happens after a merge) and the card worktrees that exist now.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { isRemoteMachine, machineProjectKey } from '../agent/daemon/machines.js';
import { BRANCH_PREFIX, listWorktrees, MAX_SLOTS, parseIsolation, removeWorktree, worktreeRoot, writeIsolation, type Isolation, type ListedWorktree } from '../agent/worktree.js';
import type { GitRunner } from '../forge/contribute.js';
import { _, fmt } from '../i18n.js';
import type { AppSettings } from '../settings.js';
import { decideDialog } from './dialogs.js';

// What the page needs from the harness controller.
export interface ProjectsAccess {
    readonly machine: string;              // '' or 'local' = this computer, else an SSH machine
    readonly git: GitRunner;               // git where the project folders are
    projectKey(project: string): string;   // the project's key in the settings
}

const AFTER_MERGE: Isolation['afterMerge'][] = ['remove', 'keep-branch'];

// A row whose title and subtitle are shown as they are: paths and branch names are not Pango markup. Markup is turned
// off before the text is set, or the text is parsed once anyway.
function plain<T extends Adw.PreferencesRow>(row: T, title: string, subtitle?: string): T {
    row.set_use_markup(false);
    row.set_title(title);
    if (subtitle !== undefined && row instanceof Adw.ActionRow) row.set_subtitle(subtitle);
    return row;
}

// The projects of the machine agents run on, as name → folder.
export function machineProjects(settings: AppSettings, machine: string): Record<string, string> {
    if (!isRemoteMachine(machine)) return settings.projects;
    const prefix = machineProjectKey(machine, '');
    return Object.fromEntries(Object.entries(settings.machineProjects).filter(([key]) => key.startsWith(prefix)).map(([key, folder]) => [key.slice(prefix.length), folder]));
}

// The "Projects" group; its rows open a project's page in the dialog.
export class ProjectsGroup {
    readonly group: Adw.PreferencesGroup;
    private rows: Adw.ActionRow[] = [];

    constructor(private readonly dialog: Adw.PreferencesDialog, private readonly settings: AppSettings, private readonly access: ProjectsAccess) {
        this.group = new Adw.PreferencesGroup({ title: _('Projects'), description: _('The folders cards are worked on in. In a Git repository each card gets its own worktree, so several cards can work at once and you review the changes before they are merged.') });
        this.fill();
        settings.onChanged(['projects', 'machine-projects', 'harness-machine'], () => this.fill());
    }

    private fill(): void {
        for (const row of this.rows.splice(0)) this.group.remove(row);
        const projects = Object.entries(machineProjects(this.settings, this.access.machine));
        if (!projects.length) {
            const empty = new Adw.ActionRow({ title: _('No projects yet'), subtitle: _('A project is added when a card is first given to an agent') });
            empty.add_css_class('dim-label');
            this.add(empty);
            return;
        }
        for (const [name, folder] of projects) {
            const isolation = parseIsolation(this.settings.projectOptions[this.access.projectKey(name)]);
            const row = plain(new Adw.ActionRow({ activatable: true }), name, `${folder} · ${isolation.worktrees ? _('a worktree per card') : _('in the folder itself')}`);
            row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
            row.connect('activated', () => this.dialog.push_subpage(projectPage(this.settings, this.access, name, folder)));
            this.add(row);
        }
    }

    private add(row: Adw.ActionRow): void {
        this.group.add(row);
        this.rows.push(row);
    }
}

// The page of one project.
export function projectPage(settings: AppSettings, access: ProjectsAccess, name: string, folder: string): Adw.NavigationPage {
    const key = access.projectKey(name);
    const read = () => parseIsolation(settings.projectOptions[key]);
    const save = (patch: Partial<Isolation>) => { settings.projectOptions = { ...settings.projectOptions, [key]: writeIsolation({ ...read(), ...patch }) }; };
    const isolation = read();
    const machine = isRemoteMachine(access.machine) ? access.machine : _('this computer');

    const page = new Adw.PreferencesPage();
    const where = new Adw.PreferencesGroup({ title: _('Folder') });
    where.add(plain(new Adw.ActionRow({ subtitle_selectable: true }), _('Project folder'), `${folder} · ${machine}`));
    page.add(where);

    const iso = new Adw.PreferencesGroup({ title: _('Isolation'), description: _('Without Git, or with worktrees off, cards work in the folder itself, one at a time, and there is nothing to review in Markwork.') });
    const worktrees = plain(new Adw.SwitchRow({ active: isolation.worktrees }), _('Give each card its own worktree'), fmt(_('Each card works on its own branch ({prefix}…) in its own folder; nothing touches the project folder until you merge'), { prefix: BRANCH_PREFIX }));
    const slots = new Adw.SpinRow({ title: _('Cards at the same time'), subtitle: isRemoteMachine(access.machine) ? fmt(_('markworkd on {machine} keeps the others waiting, also when Markwork is closed'), { machine: access.machine }) : _('The others wait their turn'), adjustment: new Gtk.Adjustment({ lower: 1, upper: MAX_SLOTS, step_increment: 1, value: isolation.slots }) });
    const base = new Adw.EntryRow({ title: _('Base branch (empty: the branch the folder is on)'), text: isolation.base, show_apply_button: true });
    // The default folder is long; it shows as the entry's tooltip.
    const dir = plain(new Adw.EntryRow({ text: isolation.dir, show_apply_button: true }), _('Worktree folder (empty: next to the project)'));
    const after = new Adw.ComboRow({ title: _('After merging'), subtitle: _('The worktree folder is always removed'), model: Gtk.StringList.new([_('Delete the branch'), _('Keep the branch')]), selected: AFTER_MERGE.indexOf(isolation.afterMerge) });
    dir.set_tooltip_text(fmt(_('Empty: {path}'), { path: worktreeRoot(folder) }));
    worktrees.connect('notify::active', () => { save({ worktrees: worktrees.active }); sync(); });
    slots.connect('notify::value', () => save({ slots: Math.round(slots.value) }));
    base.connect('apply', () => save({ base: base.text.trim() }));
    dir.connect('apply', () => {
        const text = dir.text.trim();
        if (text && !text.startsWith('/')) { dir.add_css_class('error'); return; }
        dir.remove_css_class('error');
        save({ dir: text });
    });
    after.connect('notify::selected', () => save({ afterMerge: AFTER_MERGE[after.selected] ?? 'remove' }));
    const sync = () => { for (const row of [slots, base, dir, after]) row.set_sensitive(worktrees.active); };
    sync();
    for (const row of [worktrees, slots, base, dir, after]) iso.add(row);
    page.add(iso);

    page.add(worktreesGroup(access, folder));
    // A subpage brings its own header bar, with the back button and its title.
    const view = new Adw.ToolbarView({ content: page });
    view.add_top_bar(new Adw.HeaderBar());
    return new Adw.NavigationPage({ title: name, child: view, tag: `project-${name}` });
}

// The card worktrees of the project's repository, read from git; each can be removed with its branch.
function worktreesGroup(access: ProjectsAccess, folder: string): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({ title: _('Card worktrees') });
    const rows: Gtk.Widget[] = [];
    const show = (row: Gtk.Widget) => { group.add(row); rows.push(row); };
    const load = async () => {
        for (const row of rows.splice(0)) group.remove(row);
        show(new Adw.ActionRow({ title: _('Looking…') }));
        const listed = (await listWorktrees(access.git, folder)).filter(w => w.branch?.startsWith(BRANCH_PREFIX));
        for (const row of rows.splice(0)) group.remove(row);
        if (!listed.length) show(new Adw.ActionRow({ title: _('None'), subtitle: _('Worktrees appear here while their cards are worked on or wait for review') }));
        for (const wt of listed) show(worktreeRow(group, access, folder, wt, () => void load()));
    };
    void load();
    return group;
}

function worktreeRow(group: Gtk.Widget, access: ProjectsAccess, folder: string, wt: ListedWorktree, reload: () => void): Adw.ActionRow {
    const row = plain(new Adw.ActionRow({ subtitle_selectable: true }), wt.branch ?? '', wt.path);
    const remove = new Gtk.Button({ label: _('Remove…'), valign: Gtk.Align.CENTER });
    remove.add_css_class('flat');
    remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Remove the worktree {branch}'), { branch: wt.branch ?? wt.path })]);
    remove.connect('clicked', async () => {
        const root = group.get_root();
        const yes = await decideDialog(root instanceof Gtk.Window ? root : null, fmt(_('Remove the worktree of {branch}?'), { branch: wt.branch ?? '' }),
            _('Its folder and its branch are deleted, with every change in them that was not merged. The project folder is not touched.'), _('Remove'), true);
        if (!yes) return;
        remove.set_sensitive(false);
        const done = await removeWorktree(access.git, { path: wt.path, cwd: wt.path, branch: wt.branch ?? '', base: '', baseCommit: '', repo: folder });
        if (!done.ok) { row.set_subtitle(done.message); remove.set_sensitive(true); return; }
        reload();
    });
    row.add_suffix(remove);
    return row;
}

