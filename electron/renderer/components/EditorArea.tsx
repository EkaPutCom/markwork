import { useEffect, useRef } from 'react';
import { Home } from './Home.js';
import { HtmlPage } from './HtmlPage.js';
import { Board } from './Board.js';
import { Calendar } from './Calendar.js';
import { Chart } from './Chart.js';
import { Csv } from './Csv.js';
import { Gallery } from './Gallery.js';
import { Inbox } from './Inbox.js';
import { PullPage } from './Pull.js';
import { ReviewPage } from './Review.js';
import { TableView } from './TableView.js';
import { Timeline } from './Timeline.js';
import type { Board as BoardData } from '../../../src/markdown/kanban.js';
import type { Tab } from '../lib/client.js';
import { MarkdownEditor } from '../lib/editor.js';
import { label } from '../lib/keys.js';
import { useClient, useStore } from '../lib/useClient.js';

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
            {!root && <button className="button suggested" onClick={() => void client.openFolder()}>Open Folder</button>}
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

export function EditorArea() {
    const client = useClient();
    const { tabs, active, csvFind, pullShown: pull, reviewShown } = useStore();
    const pullShown = pull || reviewShown;
    const host = useRef<HTMLDivElement>(null);
    const tab = tabs.find(t => t.id === active);

    // One CodeMirror for the window; the tabs swap its state.
    useEffect(() => {
        const editor = new MarkdownEditor(host.current!, {
            changed: text => client.typed(text),
            moved: (line, column) => client.moved(line, column),
            message: text => client.say(text),
            openLink: uri => client.openLink(uri),
            zoomImage: image => client.zoomImage(image),
            baseDir: () => client.baseDir(),
            openNote: link => client.openNote(link),
            noteNames: () => client.noteNames(),
        });
        client.attachEditor(editor);
        return () => { client.attachEditor(null); editor.view.destroy(); };
    }, [client]);

    const board = tab?.board ?? null;
    const structured = !!tab && !!board && ['board', 'inbox', 'table', 'calendar', 'timeline', 'gallery', 'chart'].includes(tab.page);
    const csv = tab?.page === 'csv' && tab.csv !== null;
    const isPage = tab?.page === 'home' || tab?.page === 'html';
    return (
        <div className="editor-area">
            <div ref={host} className="text-editor" hidden={!tab || structured || csv || isPage || pullShown} />
            {pull && <PullPage />}
            {reviewShown && <ReviewPage />}
            {!pullShown && structured && tab && board && <StructuredPage key={`${tab.id}:${tab.page}`} tab={tab} board={board} />}
            {!pullShown && csv && tab && <Csv key={tab.id} text={tab.csv!} rev={tab.csvRev} find={csvFind} />}
            {!pullShown && tab?.page === 'home' && <Home data={tab.home} />}
            {!pullShown && tab?.page === 'html' && tab.html && <HtmlPage key={tab.id} id={tab.id} file={tab.html.file} root={tab.html.root} />}
            {!tab && !pullShown && <Welcome />}
        </div>
    );
}
