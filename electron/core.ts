// The Markwork core in an Electron utility process: the Node platform and an AppSession behind a ProtocolServer. The main
// process hands this process one end of a MessageChannel; the renderer holds the other end, and every message is one
// object per post (docs/design/protocol.md, 3.1).

import '../src/platform/node/install';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppSettings } from '../src/base/settings';
import { SETTING_KEYS } from '../src/base/settingskeys';
import { platform } from '../src/platform/index';
import { JsonSettingsStore } from '../src/platform/node/settings';
import { catalogTranslations, userCatalog } from '../src/platform/node/i18n';
import { remoteSecrets, type SecretReply } from '../src/platform/node/vault';
import { ProtocolServer } from '../src/app/protocol/server';
import type { Message } from '../src/app/protocol/messages';
import type { Provider } from '../src/agent/provider';
import type { CollabServices } from '../src/app/collab';
import type { Spawner } from '../src/orchestrator/index';

// The platform as the Node port builds it, with what the packaged app does differently: its catalogs sit next to this
// file (dist-electron/locale, from po/), and where Node has no keyring (macOS, Windows) the secrets go to the main
// process, which holds them with safeStorage. MARKWORK_SECRETS=vault does the same on Linux, for the tests.
const here = dirname(fileURLToPath(import.meta.url));
const mutable = platform() as { -readonly [K in 'translations' | 'secrets']: ReturnType<typeof platform>[K] };
mutable.translations = catalogTranslations(userCatalog(join(here, 'locale')));
const vault = platform().os !== 'linux' || process.env.MARKWORK_SECRETS === 'vault'
    ? remoteSecrets(request => process.parentPort.postMessage({ secrets: request }))
    : null;
if (vault) mutable.secrets = vault.secrets;

const { paths } = platform();
const settings = new AppSettings(new JsonSettingsStore(paths.join(paths.configDir(), 'markwork-electron', 'settings.json'), SETTING_KEYS));

// For the Playwright tests only: a module that gives the Assistant a scripted model, so no test reaches the network.
const testModel = process.env.MARKWORK_TEST_MODEL;
// Likewise a module with a fake forge (its token store, transport, and remote), so no test reaches a server.
const testForge = process.env.MARKWORK_TEST_FORGE;
// And a module with a fake agent program (`spawn`), so no test needs pi or a model.
const testHarness = process.env.MARKWORK_TEST_HARNESS;

process.parentPort.on('message', async ({ data, ports: [port] }: { data: unknown; ports: Electron.MessagePortMain[] }) => {
    // An answer of the main process's vault, not the port for the window.
    if (!port) {
        const reply = (data as { secrets?: SecretReply } | null)?.secrets;
        if (reply) vault?.receive(reply);
        return;
    }
    const provider = testModel ? ((await import(/* @vite-ignore */ testModel)) as { provider: Provider }).provider : null;
    const server = new ProtocolServer(settings, message => port.postMessage(message), { settingKeys: Object.keys(SETTING_KEYS) });
    if (provider) server.session.assistant.chat.makeProvider = () => provider;
    if (testForge) Object.assign(server.session.collab.services, ((await import(/* @vite-ignore */ testForge)) as { services: Partial<CollabServices> }).services);
    if (testHarness) {
        const { orchestrator } = server.session.harness;
        orchestrator.program = spec => spec.program;
        orchestrator.spawn = ((await import(/* @vite-ignore */ testHarness)) as { spawn: Spawner }).spawn;
    }
    port.on('message', ({ data }: { data: Message }) => server.receive(data));
    port.on('close', () => server.dispose());
    port.start();
});
