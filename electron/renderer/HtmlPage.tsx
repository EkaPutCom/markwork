// An HTML file in a tab (ui/htmlpage.ts). The page runs in a sandboxed frame and is served by the main process under the
// private scheme mwhtml://v<id>/, which answers from the page's folder and nowhere else, with a policy that keeps the page from
// reaching the network (markdown/htmlview.ts). A link that leaves the page opens in the browser, never in the frame.

import { useEffect, useState } from 'react';
import { htmlViewUrl } from '../../src/markdown/htmlview.js';
import { Icon } from './Icons.js';

export function HtmlPage({ id, file, root }: { id: number; file: string; root: string }) {
    const [reload, setReload] = useState(0);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        let live = true;
        void window.markwork.registerHtml(id, root).then(() => { if (live) setReady(true); });
        return () => { live = false; void window.markwork.unregisterHtml(id); };
    }, [id, root]);
    useEffect(() => {
        const key = (e: KeyboardEvent) => { if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) { e.preventDefault(); setReload(n => n + 1); } };
        window.addEventListener('keydown', key);
        return () => window.removeEventListener('keydown', key);
    }, []);
    const url = htmlViewUrl(id, root, file);
    return (
        <div className="html-page">
            <div className="html-bar">
                <button className="button flat" aria-label="Reload" title="Reload (Ctrl+R)" onClick={() => setReload(n => n + 1)}><Icon name="view-refresh" /></button>
                <span className="where" title={file}>{file}</span>
            </div>
            {!url ? <p className="empty">The page is outside its folder</p>
                : ready && <iframe key={reload} title={file} src={url} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />}
        </div>
    );
}
