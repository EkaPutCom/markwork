import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Client } from './client.js';
import { ClientContext } from './useClient.js';

const client = new Client();

// The preload hands over the core's end of the channel, and tells when the core has gone.
window.addEventListener('message', event => {
    if (event.data === 'markwork-port') client.connect(event.ports[0]);
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
