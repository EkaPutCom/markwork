// The ViewScreen of a frontend in another process (docs/design/protocol.md, 6.2): the page shown, the counts at the foot,
// the layout button, and which commands apply. Each becomes a notice, sent only when what it says changed. Commands are
// enabled in groups (ViewController.syncActionsEnabled makes several calls in a row), so their state is sent once the
// calls of the turn are over, as one `commands.state`.
//
// The text's own counts are not sent: the frontend has the text and counts it as it types, so `setCounts` only says
// that the counts are the text's.

import type { HomeData } from '../home';
import type { InstallWay, ProgramInfo, ProgramsData, SetupData } from '../programs';
import type { Layout } from '../../markdown/layout';
import type { StructuredPage, ViewScreen } from '../views';
import type { Wire } from './messages';
import type { ProtocolEditor } from './replica';

export type StatusCounts =
    | { kind: 'text' }
    | { kind: 'board'; lists: number; cards: number }
    | { kind: 'inbox'; items: number }
    | { kind: 'csv'; rows: number; columns: number };

type Screen = Pick<ViewScreen<ProtocolEditor>, 'showHome' | 'showPrograms' | 'showPageTab' | 'showText' | 'showPage' | 'closeFind' | 'setStatusVisible' | 'setCounts' | 'setBoardCounts'
    | 'setInboxCounts' | 'setCsvCounts' | 'showLayout' | 'setStructuredState' | 'enableActions'>;

export class ProtocolScreen implements Screen {
    private sent = { status: '', layout: '', commands: '' };
    private visible = true;
    private counts: StatusCounts = { kind: 'text' };
    private layout: Layout | '' | null = null;
    private structured = false;
    private readonly disabled = new Set<string>();
    private commandsQueued = false;

    // active: the document the page belongs to (the frontend's active tab).
    constructor(private readonly wire: Wire, private readonly active: () => number) {}

    // Home and an HTML file are tabs of their own (page.open); what a tab shows is told by its id.
    showHome(data: HomeData): void { this.wire.notify('view.home', { data }); }
    showPrograms(data: ProgramsData): void { this.wire.notify('view.programs', { data }); }
    showPageTab(id: number, kind: 'html' | 'code' | 'agent'): void { this.wire.notify('view.page', { page: kind, doc: id }); }
    showText(doc: number): void { this.wire.notify('view.page', { page: 'text', doc }); }
    showPage(page: StructuredPage | 'csv'): void { this.wire.notify('view.page', { page, doc: this.active() }); }
    closeFind(): void { this.wire.notify('find.close'); }

    setStatusVisible(visible: boolean): void { this.visible = visible; this.sendStatus(); }
    setCounts(_text: string): void { this.status({ kind: 'text' }); }
    setBoardCounts(lists: number, cards: number): void { this.status({ kind: 'board', lists, cards }); }
    setInboxCounts(items: number): void { this.status({ kind: 'inbox', items }); }
    setCsvCounts(rows: number, columns: number): void { this.status({ kind: 'csv', rows, columns }); }

    showLayout(layout: Layout | '' | null): void { this.layout = layout; this.sendLayout(); }
    setStructuredState(on: boolean): void { this.structured = on; this.sendLayout(); }

    enableActions(names: readonly string[], enabled: boolean): void {
        for (const name of names) {
            if (enabled) this.disabled.delete(name);
            else this.disabled.add(name);
        }
        if (this.commandsQueued) return;
        this.commandsQueued = true;
        void Promise.resolve().then(() => {
            this.commandsQueued = false;
            this.send('commands', 'commands.state', { disabled: [...this.disabled].sort() });
        });
    }

    private status(counts: StatusCounts): void {
        this.counts = counts;
        this.sendStatus();
    }

    private sendStatus(): void {
        this.send('status', 'view.status', { visible: this.visible, counts: this.counts });
    }

    private sendLayout(): void {
        this.send('layout', 'view.layout', { layout: this.layout, structured: this.structured });
    }

    // A notice, unless it says what the last one of its kind said.
    private send(kind: 'status' | 'layout' | 'commands', ev: string, payload: Record<string, unknown>): void {
        const key = JSON.stringify(payload);
        if (this.sent[kind] === key) return;
        this.sent[kind] = key;
        this.wire.notify(ev, payload);
    }
}

// What Home and the Programs page show, as it crosses the wire (the renderer takes the types from here).
export type { HomeData, InstallWay, ProgramInfo, ProgramsData, SetupData };
// The conflict sources and diff sent by view.conflictComparison; the editable result stays in the frontend until Apply.
export type { ConflictComparison } from '../documents';
