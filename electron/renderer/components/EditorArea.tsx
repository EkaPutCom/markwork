import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react';
import { Home } from './Home.js';
import { Programs } from './Programs.js';
import { HtmlPage } from './HtmlPage.js';
import { Board } from './Board.js';
import { Calendar } from './Calendar.js';
import { Chart } from './Chart.js';
import { Csv } from './Csv.js';
import { STRUCTURED_PAGES } from './EditingMode.js';
import { FormatBar } from './FormatBar.js';
import { ReportOffer } from './ReportProblem.js';
import { Gallery } from './Gallery.js';
import { Icon } from './Icons.js';
import { Inbox } from './Inbox.js';
import { LanguagePicker } from './LanguagePicker.js';
import { PullPage } from './Pull.js';
import { ReviewPage } from './Review.js';
import { TableView } from './TableView.js';
import { FILE_DRAG, PaneTabs, TAB_DRAG } from './Tabs.js';
import { Timeline } from './Timeline.js';
import type { Board as BoardData } from '../../../src/markdown/kanban.js';
import type { Tab } from '../lib/client.js';
import type { LanguagePick } from '../lib/codecolor.js';
import { MarkdownEditor } from '../lib/editor.js';
import { label } from '../lib/keys.js';
import { isSolo, type Pane as PaneData, type Zone } from '../lib/panes.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Button } from '../ui/button.js';
import { IconButton } from '../ui/icon-button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { COMMANDS } from '../../../src/app/commands.js';

function Welcome() {
    const client = useClient();
    const { root } = useStore();
    const hint = (text: string, keys: string) => <li><span>{text}</span><kbd>{label(keys)}</kbd></li>;
    return (
        <div className="welcome-page">
            <h1>Markwork</h1>
            <p className="subtitle">Markdown workspace for humans and AI agents</p>
            <ul className="hints">
                {hint('Show All Commands', 'Ctrl+Shift+P')}
                {hint('Open Folder', 'Ctrl+Shift+O')}
                {hint('New Document', 'Ctrl+N')}
            </ul>
            {!root && <Button onClick={() => void client.openFolder()}>Open Folder</Button>}
        </div>
    );
}

// The page of a document's notes that the core shows: the same board, drawn as a board, a list, a table, or one of the layouts.
function StructuredPage({ tab, board }: { tab: Tab; board: BoardData }) {
    switch (tab.page) {
        case 'inbox': return <Inbox board={board} focus={tab.capture} tab={tab.id} />;
        case 'table': return <TableView board={board} focus={tab.capture} tab={tab.id} />;
        case 'calendar': return <Calendar board={board} />;
        case 'timeline': return <Timeline board={board} />;
        case 'gallery': return <Gallery board={board} />;
        case 'chart': return <Chart board={board} />;
        default: return <Board board={board} groupField={tab.groupField} agents={tab.agents} runs={tab.runs} />;
    }
}

const keysOf = (id: string): string => { const k = COMMANDS.find(c => c.id === id)?.keys[0]; return k ? label(k) : ''; };

// Where a drag over a pane would land: its middle joins the tabs, an edge makes a pane beside it. Over the tab bar it joins.
function zoneAt(pane: HTMLElement, body: HTMLElement | null, e: DragEvent): Zone {
    const box = pane.getBoundingClientRect(), top = body?.getBoundingClientRect().top ?? box.top;
    if (e.clientY < top) return 'center';
    const x = (e.clientX - box.left) / box.width, y = (e.clientY - top) / (box.bottom - top);
    return x < 0.25 ? 'left' : x > 0.75 ? 'right' : y < 0.25 ? 'top' : y > 0.75 ? 'bottom' : 'center';
}
const ZONE_BOX: Record<Zone, [number, number, number, number]> = { left: [0, 0, 50, 100], right: [50, 0, 50, 100], top: [0, 0, 100, 50], bottom: [0, 50, 100, 50], center: [0, 0, 100, 100] };
const ZONE_LABEL: Record<Zone, string> = { left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down', center: 'Open here' };

// One pane: its tabs, and the document of its active tab drawn as text or as one of the pages. Its editor is its own; the
// tab's document may be shown by another pane too, and the panes follow each other's text.
function Pane({ pane, solo }: { pane: PaneData; solo: boolean }) {
    const client = useClient();
    const { tabs, panes, settings, csvFind } = useStore();
    const host = useRef<HTMLDivElement>(null), root = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null);
    const [zone, setZone] = useState<Zone | null>(null);
    const [menu, setMenu] = useState(false);
    const [language, setLanguage] = useState<LanguagePick | null>(null);
    const tab = tabs.find(t => t.id === pane.active);
    const current = panes.current === pane.id;
    const index = panes.columns.flatMap(c => c.panes).findIndex(p => p.id === pane.id);

    // One CodeMirror for the pane; its tabs swap its state.
    useEffect(() => {
        const editor = new MarkdownEditor(host.current!, {
            changed: text => client.typed(text, pane.id),
            moved: (line, column) => client.moved(line, column, pane.id),
            message: text => client.say(text),
            openLink: uri => client.openLink(uri, client.paneDoc(pane.id)),
            zoomImage: image => client.zoomImage(image),
            compareConflict: line => { client.focusPane(pane.id); client.compareConflict(client.paneDoc(pane.id), line); },
            baseDir: () => client.baseDir(client.paneDoc(pane.id)),
            openNote: link => client.openNote(link, client.paneDoc(pane.id)),
            noteNames: () => client.noteNames(client.paneDoc(pane.id)),
            run: (id, arg) => { client.focusPane(pane.id); client.run(id, arg); },
            format: format => client.formatted(format, pane.id),
            chooseLanguage: setLanguage,
        });
        client.attachEditor(pane.id, editor);
        return () => { client.attachEditor(pane.id, null); editor.view.destroy(); };
    }, [client, pane.id]);

    const board = tab?.board ?? null;
    const structured = !!tab && !!board && STRUCTURED_PAGES.includes(tab.page);
    const csv = tab?.page === 'csv' && tab.csv !== null;
    const isPage = tab?.page === 'home' || tab?.page === 'programs' || tab?.page === 'html';
    const textShown = !!tab && !structured && !csv && !isPage;

    const over = (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG) && !e.dataTransfer.types.includes(FILE_DRAG)) return;
        e.preventDefault();
        setZone(zoneAt(e.currentTarget as HTMLElement, body.current, e));
    };
    const drop = (e: DragEvent) => {
        const at = zoneAt(e.currentTarget as HTMLElement, body.current, e);
        setZone(null);
        const tabData = e.dataTransfer.getData(TAB_DRAG), file = e.dataTransfer.getData(FILE_DRAG);
        if (!tabData && !file) return;
        e.preventDefault();
        e.stopPropagation();
        if (tabData) { const { pane: from, doc } = JSON.parse(tabData) as { pane: number; doc: number }; client.dropTab(from, doc, pane.id, at); }
        else client.dropFile(file, pane.id, at);
    };
    const box = zone ? ZONE_BOX[zone] : null;

    return (
        <section ref={root} className={`pane${current ? ' current' : ''}${solo ? ' solo' : ''}`} data-pane={pane.id} style={{ flex: `${pane.size} 1 0` }}
            aria-label={solo ? undefined : `Pane ${index + 1}`}
            onMouseDownCapture={() => client.focusPane(pane.id)} onFocusCapture={() => client.focusPane(pane.id)}
            onDragOver={over} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null); }} onDrop={drop}>
            {(!solo || pane.tabs.length > 0) && (
                <div className="pane-bar">
                    <PaneTabs pane={pane} solo={false} label={solo ? 'Open documents' : `Documents of pane ${index + 1}`} onMenu={() => setMenu(true)} />
                    <span className="spacer" />
                    <IconButton label="Split Right" shortcut={keysOf('split-right')} onClick={() => client.splitPane('right', pane.id)}>
                        <Icon name="split-right" />
                    </IconButton>
                    <DropdownMenu open={menu} onOpenChange={setMenu}>
                        <DropdownMenuTrigger asChild>
                            <IconButton label="Pane actions"><Icon name="view-more-horizontal" /></IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-56" onCloseAutoFocus={e => { e.preventDefault(); client.focusEditor(); }}>
                            <DropdownMenuItem onSelect={() => client.splitPane('right', pane.id)}><Icon name="split-right" />Split Right<DropdownMenuShortcut>{keysOf('split-right')}</DropdownMenuShortcut></DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => client.splitPane('bottom', pane.id)}><Icon name="split-down" />Split Down<DropdownMenuShortcut>{keysOf('split-down')}</DropdownMenuShortcut></DropdownMenuItem>
                            {pane.tabs.includes(pane.active) && <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => client.closeTab(pane.active, pane.id)}>Close<DropdownMenuShortcut>{keysOf('close-tab')}</DropdownMenuShortcut></DropdownMenuItem>
                                <DropdownMenuItem disabled={pane.tabs.length < 2} onSelect={() => client.closeTabs(pane.tabs.filter(t => t !== pane.active), pane.id)}>Close Others</DropdownMenuItem>
                                <DropdownMenuItem disabled={pane.tabs.at(-1) === pane.active} onSelect={() => client.closeTabs(pane.tabs.slice(pane.tabs.indexOf(pane.active) + 1), pane.id)}>Close to the Right</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => client.closeTabs(pane.tabs, pane.id)}>Close All<DropdownMenuShortcut>{keysOf('close-all-tabs')}</DropdownMenuShortcut></DropdownMenuItem>
                            </>}
                            {!solo && <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => { client.focusPane(pane.id); client.moveToNextPane(); }}>Move Tab to Next Pane</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => { client.focusPane(pane.id); client.joinPanes(); }}>Join All Panes</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => client.closePane(pane.id)}>Close Pane</DropdownMenuItem>
                            </>}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
            {textShown && settings.visual !== false && !pane.source && <FormatBar pane={pane} />}
            <div ref={body} className="pane-body">
                {current && textShown && <ReportOffer />}
                {language && <LanguagePicker pick={language} onClose={() => setLanguage(null)} />}
                <div ref={host} className="text-editor" hidden={!textShown} />
                {structured && tab && board && <StructuredPage key={`${tab.id}:${tab.page}`} tab={tab} board={board} />}
                {csv && tab && <Csv key={tab.id} text={tab.csv!} rev={tab.csvRev} find={current ? csvFind : { n: 0, replace: false }} />}
                {tab?.page === 'home' && <Home data={tab.home} />}
                {tab?.page === 'programs' && <Programs data={tab.programs} />}
                {tab?.page === 'html' && tab.html && <HtmlPage key={tab.id} id={tab.id} file={tab.html.file} root={tab.html.root} />}
                {!tab && solo && <Welcome />}
                {!tab && !solo && <div className="pane-empty"><b>No file open</b>Drag a file here, or close this pane.</div>}
                {box && (
                    <div className="pane-zone" aria-hidden="true" style={{ left: `${box[0]}%`, top: `${box[1]}%`, width: `${box[2]}%`, height: `${box[3]}%` }}><span>{ZONE_LABEL[zone!]}</span></div>
                )}
            </div>
        </section>
    );
}

// The line between two columns or two panes: dragged, it moves the share of the two it separates.
function Sash({ vertical, total, onMove }: { vertical: boolean; total: number; onMove: (share: number) => void }) {
    const drag = useRef<{ last: number; size: number } | null>(null);
    const [on, setOn] = useState(false);
    return (
        <div role="separator" aria-orientation={vertical ? 'vertical' : 'horizontal'} className={`sash ${vertical ? 'vertical' : 'horizontal'}${on ? ' on' : ''}`}
            onPointerDown={e => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const parent = e.currentTarget.parentElement!.getBoundingClientRect();
                drag.current = { last: vertical ? e.clientX : e.clientY, size: vertical ? parent.width : parent.height };
                setOn(true);
            }}
            onPointerMove={e => {
                const d = drag.current;
                if (!d) return;
                const at = vertical ? e.clientX : e.clientY;
                onMove((at - d.last) / d.size * total);
                d.last = at;
            }}
            onPointerUp={() => { drag.current = null; setOn(false); }} />
    );
}

// The editor area: the panes in columns, or the review of a pull request or of a card's work in place of them.
export function EditorArea() {
    const client = useClient();
    const { panes, pullShown: pull, reviewShown } = useStore();
    const solo = isSolo(panes);
    const widths = panes.columns.reduce((n, c) => n + c.size, 0);
    return (
        <div className="editor-area">
            <div className="pane-grid" hidden={pull || reviewShown}>
                {panes.columns.map((column, ci) => (
                    <Fragment key={column.panes[0].id}>
                        {ci > 0 && <Sash vertical total={widths} onMove={share => client.resizeColumns(ci - 1, share)} />}
                        <div className="pane-col" style={{ flex: `${column.size} 1 0` }}>
                            {column.panes.map((pane, pi) => (
                                <Fragment key={pane.id}>
                                    {pi > 0 && <Sash vertical={false} total={column.panes.reduce((n, p) => n + p.size, 0)} onMove={share => client.resizePanes(ci, pi - 1, share)} />}
                                    <Pane pane={pane} solo={solo} />
                                </Fragment>
                            ))}
                        </div>
                    </Fragment>
                ))}
            </div>
            {pull && <PullPage />}
            {reviewShown && <ReviewPage />}
        </div>
    );
}
