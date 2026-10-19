// Starting the conversation and the settings (docs/design/protocol.md, 4.5, 8, and 9.2). The `hello` reply carries the
// command table and every setting; after that a setting changed on either side is one `setting` notice.

import type { SettingValue } from '../../../platform/index.js';
import { RequestError } from '../messages.js';
import { commandTable } from './commands.js';
import { str, type HandlerContext } from './context.js';

export const PROTOCOL_VERSION = 1;

export function sessionHandlers({ wire, session, settingKeys, notice, onDispose }: HandlerContext): void {
    const { store } = session.settings;
    const known = (key: string) => settingKeys.length === 0 || settingKeys.includes(key);

    wire.on('hello', p => {
        if (p.proto !== PROTOCOL_VERSION) throw new RequestError('proto', `this core speaks protocol ${PROTOCOL_VERSION}`);
        return {
            proto: PROTOCOL_VERSION, core: 'markwork',
            commands: commandTable(),
            settings: Object.fromEntries(settingKeys.map(key => [key, store.get(key)])),
        };
    });

    // The window is closing: the core asks about every changed document (ask.saveChanges), then says whether it may.
    wire.on('app.close', async () => ({ allowed: await session.closeRequest() }));

    // A setting the frontend changed (a toggle in its menu, the sidebar it closed). A key the core does not have is
    // reported, not written.
    notice('setting', p => {
        const key = str(p.key, 'key');
        if (!known(key) || p.value === undefined) {
            wire.notify('error', { message: `No such setting: ${key}` });
            return;
        }
        try {
            store.set(key, p.value as SettingValue);
        } catch (e) {
            wire.notify('error', { message: e instanceof Error ? e.message : String(e) });
        }
    });

    // Every change, whoever made it: the frontend draws from the core's values. Its own change comes back too, which is
    // harmless: the value is the one it set.
    onDispose(session.settings.onChanged(null, key => {
        if (known(key)) wire.notify('setting', { key, value: store.get(key) });
    }));
}
