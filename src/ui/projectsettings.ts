// Preferences → Agents → Projects: the projects the agents work on (on the machine they run on), and for each one a
// page with how its cards are isolated and the card worktrees that exist now. Both are views (app/projects.ts): they draw
// what the core sends and report what the user did through the preferences view.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import type { PreferencesView } from '../app/preferences.js';
import { AFTER_MERGE, type ProjectPage, type ProjectRow, type WorktreeList } from '../app/projects.js';
import { _, fmt } from '../i18n.js';

// A row whose title and subtitle are shown as they are: paths and branch names are not Pango markup. Markup is turned
// off before the text is set, or the text is parsed once anyway.
function plain<T extends Adw.PreferencesRow>(row: T, title: string, subtitle?: string): T {
    row.set_use_markup(false);
    row.set_title(title);
    if (subtitle !== undefined && row instanceof Adw.ActionRow) row.set_subtitle(subtitle);
    return row;
}

// The "Projects" group; its rows ask the core for a project's page.
export class ProjectsGroup {
    readonly group: Adw.PreferencesGroup;
    private rows: Adw.ActionRow[] = [];
    private shown = '';

    constructor(private readonly view: PreferencesView) {
        this.group = new Adw.PreferencesGroup({ title: _('Projects'), description: _('The folders cards are worked on in. In a Git repository each card gets its own worktree, so several cards can work at once and you review the changes before they are merged.') });
    }

    setRows(projects: readonly ProjectRow[]): void {
        const shown = JSON.stringify(projects);
        if (shown === this.shown) return;
        this.shown = shown;
        for (const row of this.rows.splice(0)) this.group.remove(row);
        if (!projects.length) {
            const empty = new Adw.ActionRow({ title: _('No projects yet'), subtitle: _('A project is added when a card is first given to an agent') });
            empty.add_css_class('dim-label');
            this.add(empty);
            return;
        }
        for (const { name, folder, worktrees } of projects) {
            const row = plain(new Adw.ActionRow({ activatable: true }), name, `${folder} · ${worktrees ? _('a worktree per card') : _('in the folder itself')}`);
            row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
            row.connect('activated', () => this.view.onOpenProject(name));
            this.add(row);
        }
    }

    private add(row: Adw.ActionRow): void {
        this.group.add(row);
        this.rows.push(row);
    }
}

// The page of one project.
export class ProjectSubpage {
    readonly navigation: Adw.NavigationPage;
    private readonly worktrees: Adw.PreferencesGroup;
    private readonly rows: Gtk.Widget[] = [];

    constructor(private readonly view: PreferencesView, private readonly project: ProjectPage) {
        const { name, folder, isolation } = project;
        const save = (patch: Parameters<PreferencesView['onSetProject']>[1]) => view.onSetProject(name, patch);

        const page = new Adw.PreferencesPage();
        const where = new Adw.PreferencesGroup({ title: _('Folder') });
        where.add(plain(new Adw.ActionRow({ subtitle_selectable: true }), _('Project folder'), `${folder} · ${project.machine}`));
        page.add(where);

        const iso = new Adw.PreferencesGroup({ title: _('Isolation'), description: _('Without Git, or with worktrees off, cards work in the folder itself, one at a time, and there is nothing to review in Markwork.') });
        const worktrees = plain(new Adw.SwitchRow({ active: isolation.worktrees }), _('Give each card its own worktree'), fmt(_('Each card works on its own branch ({prefix}…) in its own folder; nothing touches the project folder until you merge'), { prefix: project.branchPrefix }));
        const slots = new Adw.SpinRow({ title: _('Cards at the same time'), subtitle: project.remote ? fmt(_('markworkd on {machine} keeps the others waiting, also when Markwork is closed'), { machine: project.machine }) : _('The others wait their turn'), adjustment: new Gtk.Adjustment({ lower: 1, upper: project.maxSlots, step_increment: 1, value: isolation.slots }) });
        const base = new Adw.EntryRow({ title: _('Base branch (empty: the branch the folder is on)'), text: isolation.base, show_apply_button: true });
        // The default folder is long; it shows as the entry's tooltip.
        const dir = plain(new Adw.EntryRow({ text: isolation.dir, show_apply_button: true }), _('Worktree folder (empty: next to the project)'));
        const after = new Adw.ComboRow({ title: _('After merging'), subtitle: _('The worktree folder is always removed'), model: Gtk.StringList.new([_('Delete the branch'), _('Keep the branch')]), selected: AFTER_MERGE.indexOf(isolation.afterMerge) });
        dir.set_tooltip_text(fmt(_('Empty: {path}'), { path: project.defaultDir }));
        const sync = () => { for (const row of [slots, base, dir, after]) row.set_sensitive(worktrees.active); };
        worktrees.connect('notify::active', () => { save({ worktrees: worktrees.active }); sync(); });
        slots.connect('notify::value', () => save({ slots: Math.round(slots.value) }));
        base.connect('apply', () => save({ base: base.text.trim() }));
        dir.connect('apply', () => {
            // The core refuses a folder that is not an absolute path.
            const error = save({ dir: dir.text.trim() });
            if (error) dir.add_css_class('error'); else dir.remove_css_class('error');
        });
        after.connect('notify::selected', () => save({ afterMerge: AFTER_MERGE[after.selected] ?? 'remove' }));
        sync();
        for (const row of [worktrees, slots, base, dir, after]) iso.add(row);
        page.add(iso);

        this.worktrees = new Adw.PreferencesGroup({ title: _('Card worktrees') });
        page.add(this.worktrees);
        // A subpage brings its own header bar, with the back button and its title.
        const toolbar = new Adw.ToolbarView({ content: page });
        toolbar.add_top_bar(new Adw.HeaderBar());
        this.navigation = new Adw.NavigationPage({ title: name, child: toolbar, tag: `project-${name}` });
    }

    get name(): string { return this.project.name; }

    // The card worktrees, each removable with its branch.
    showWorktrees(list: WorktreeList): void {
        for (const row of this.rows.splice(0)) this.worktrees.remove(row);
        const show = (row: Gtk.Widget) => { this.worktrees.add(row); this.rows.push(row); };
        if (list.loading && !list.items.length) show(new Adw.ActionRow({ title: _('Looking…') }));
        else if (!list.items.length) show(new Adw.ActionRow({ title: _('None'), subtitle: _('Worktrees appear here while their cards are worked on or wait for review') }));
        for (const wt of list.items) show(this.worktreeRow(wt.branch, wt.path, list.error));
    }

    private worktreeRow(branch: string, path: string, error: string): Adw.ActionRow {
        const row = plain(new Adw.ActionRow({ subtitle_selectable: true }), branch, error || path);
        const remove = new Gtk.Button({ label: _('Remove…'), valign: Gtk.Align.CENTER });
        remove.add_css_class('flat');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Remove the worktree {branch}'), { branch: branch || path })]);
        remove.connect('clicked', async () => {
            remove.set_sensitive(false);
            const failed = await this.view.onRemoveWorktree(this.project.name, path);
            if (failed) { row.set_subtitle(failed); remove.set_sensitive(true); } else remove.set_sensitive(true);
        });
        row.add_suffix(remove);
        return row;
    }
}
