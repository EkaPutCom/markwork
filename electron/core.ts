// The Markwork core in an Electron utility process: the Node platform and an AppSession behind a ProtocolServer. The main
// process hands this process one end of a MessageChannel; the renderer holds the other end, and every message is one
// object per post (docs/design/protocol.md, 3.1).

import '../src/platform/node/install.js';
import schema from '../data/com.ekaput.Markwork.gschema.xml?raw';
import { AppSettings } from '../src/settings.js';
import { platform } from '../src/platform/index.js';
import { JsonSettingsStore, parseSchema } from '../src/platform/node/settings.js';
import { ProtocolServer } from '../src/app/protocol/server.js';
import type { Message } from '../src/app/protocol/messages.js';
import type { Provider } from '../src/agent/provider.js';
import type { CollabServices } from '../src/app/collab.js';

const { paths } = platform();
const specs = parseSchema(schema);
const settings = new AppSettings(new JsonSettingsStore(paths.join(paths.configDir(), 'markwork-electron', 'settings.json'), specs));

// For the Playwright tests only: a module that gives the Assistant a scripted model, so no test reaches the network.
const testModel = process.env.MARKWORK_TEST_MODEL;
// Likewise a module with a fake forge (its token store, transport, and remote), so no test reaches a server.
const testForge = process.env.MARKWORK_TEST_FORGE;

process.parentPort.on('message', async ({ ports: [port] }) => {
    const provider = testModel ? ((await import(/* @vite-ignore */ testModel)) as { provider: Provider }).provider : null;
    const server = new ProtocolServer(settings, message => port.postMessage(message), { settingKeys: Object.keys(specs) });
    if (provider) server.session.assistant.chat.makeProvider = () => provider;
    if (testForge) Object.assign(server.session.collab.services, ((await import(/* @vite-ignore */ testForge)) as { services: Partial<CollabServices> }).services);
    port.on('message', ({ data }: { data: Message }) => server.receive(data));
    port.on('close', () => server.dispose());
    port.start();
});
