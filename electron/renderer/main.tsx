import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Client } from './lib/client';
import { ClientContext } from './lib/useClient';
import { watchChecks } from './lib/inspect/checks';
import { startBridge } from './lib/inspect/bridge';
import { traceCommands } from './lib/inspect/recorder';

const client = new Client();
// Dev mode checks every transaction of the editor (docs/design/debugger.md); a normal build only records them.
// It also answers the inspector's bridge, for scripts/editor.mjs, and names the commands that take the keys.
if (window.markwork.devMode) { watchChecks(); startBridge(client); traceCommands(true); }

// The preload hands over the core's end of the channel, and tells when the core has gone.
window.addEventListener('message', event => {
    if (event.data === 'markwork-close-request') void client.closeRequested();
    else if (event.data === 'markwork-port') client.connect(event.ports[0]);
    else if (event.data?.coreExit) client.coreExited(event.data.coreExit.code, event.data.coreExit.stderr);
});
window.addEventListener('focus', () => client.windowActive(true));
window.addEventListener('blur', () => client.windowActive(false));

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ClientContext.Provider value={client}>
            <App />
        </ClientContext.Provider>
    </StrictMode>,
);
