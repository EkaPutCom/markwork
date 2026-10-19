import { useEffect, useRef } from 'react';
import { Home } from './Home.js';
import { HtmlPage } from './HtmlPage.js';
import { Board } from './Board.js';
import { MarkdownEditor } from './editor.js';
import { label } from './keys.js';
import { useClient, useStore } from './useClient.js';

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

export function EditorArea() {
    const client = useClient();
    const { tabs, active } = useStore();
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

    const board = tab?.page === 'board' && tab.board;
    const isPage = tab?.page === 'home' || tab?.page === 'html';
    return (
        <div className="editor-area">
            <div ref={host} className="text-editor" hidden={!tab || !!board || isPage} />
            {board && tab && <Board board={board} />}
            {tab?.page === 'home' && <Home data={tab.home} />}
            {tab?.page === 'html' && tab.html && <HtmlPage key={tab.id} id={tab.id} file={tab.html.file} root={tab.html.root} />}
            {!tab && <Welcome />}
        </div>
    );
}
