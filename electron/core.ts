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

const { paths } = platform();
const settings = new AppSettings(new JsonSettingsStore(paths.join(paths.configDir(), 'markwork-electron', 'settings.json'), parseSchema(schema)));

process.parentPort.on('message', ({ ports: [port] }) => {
    const server = new ProtocolServer(settings, message => port.postMessage(message));
    port.on('message', ({ data }: { data: Message }) => server.receive(data));
    port.on('close', () => server.dispose());
    port.start();
});
