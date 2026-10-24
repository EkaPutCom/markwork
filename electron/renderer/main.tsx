import './styles/globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Client } from './lib/client.js';
import { ClientContext } from './lib/useClient.js';
import { watchChecks } from './lib/inspect/checks.js';

const client = new Client();
// Dev mode checks every transaction of the editor (docs/design/debugger.md); a normal build only records them.
if (window.markwork.devMode) watchChecks();

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
