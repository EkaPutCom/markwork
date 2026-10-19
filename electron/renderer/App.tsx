// The window, laid out as VS Code lays out its own: activity bar, side bar, editor group, status bar, and the command
// palette over all of it.

import { useEffect } from 'react';
import { COMMANDS } from '../../src/app/commands.js';
import { EditorArea } from './EditorArea.js';
import { Explorer } from './Explorer.js';
import { Palette } from './Palette.js';
import { Tabs } from './Tabs.js';
import { matches } from './keys.js';
import { useClient, useStore } from './useClient.js';

function ActivityBar() {
    const client = useClient();
    const { sidebar } = useStore();
    return (
        <nav className="activitybar" aria-label="Activity bar">
            <button className={`action${sidebar ? ' checked' : ''}`} title="Explorer" aria-label="Explorer" aria-pressed={sidebar} onClick={() => client.toggleSidebar()}>
                <i className="codicon codicon-files" />
            </button>
            <div className="spacer" />
            <button className="action" title="Command Palette (Ctrl+Shift+P)" aria-label="Command Palette" onClick={() => client.openPalette()}>
                <i className="codicon codicon-settings-gear" />
            </button>
        </nav>
    );
}

function StatusBar() {
    const client = useClient();
    const s = useStore();
    const tab = s.tabs.find(t => t.id === s.active);
    const folder = s.root ? s.root.split(/[\\/]/).pop() : null;
    return (
        <footer className={`statusbar${s.root ? '' : ' nofolder'}`}>
            <div className="left">
                <button className="item" onClick={() => void client.openFolder()} title={s.root ?? 'Open a folder'}>
                    <i className="codicon codicon-folder-opened" /> {folder ?? 'Open Folder'}
                </button>
            </div>
            <div className="right">
                {tab && tab.page !== 'board' && <span className="item">Ln {s.line}, Col {s.column}</span>}
                {tab && <span className="item">Spaces: 4</span>}
                {tab && <span className="item">UTF-8</span>}
                {tab && <span className="item">LF</span>}
                {tab && <button className="item" onClick={() => client.run('source')} title="Source Mode (Ctrl+/)">{s.source ? 'Source' : 'Markdown'}</button>}
                {!s.ready && <span className="item">Starting…</span>}
            </div>
        </footer>
    );
}

function Notification() {
    const client = useClient();
    const { toast, coreError } = useStore();
    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => client.dismissToast(), 6000);
        return () => clearTimeout(timer);
    }, [toast, client]);
    const text = coreError ?? toast?.text;
    if (!text) return null;
    return (
        <div className={`notification${coreError ? ' error' : ''}`} role="alert">
            <i className={`codicon codicon-${coreError ? 'error' : 'info'}`} />
            <span className="message">{text}</span>
            {toast?.action && <button className="primary" onClick={() => client.runToast(toast.action!.token)}>{toast.action.label}</button>}
            {!coreError && <button className="close" aria-label="Dismiss" onClick={() => client.dismissToast()}><i className="codicon codicon-close" /></button>}
        </div>
    );
}

export function App() {
    const client = useClient();
    const { sidebar } = useStore();

    // Every key of the command table, for the commands this window carries out. Captured before the editor sees it.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            for (const command of COMMANDS) {
                if (command.keys.some(k => matches(event, k)) && client.enabled(command)) {
                    event.preventDefault();
                    event.stopPropagation();
                    client.run(command.id);
                    return;
                }
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [client]);

    return (
        <div className="workbench">
            <div className="main">
                <ActivityBar />
                {sidebar && <Explorer />}
                <div className="editor-group">
                    <Tabs />
                    <EditorArea />
                </div>
            </div>
            <StatusBar />
            <Notification />
            <Palette />
        </div>
    );
}
