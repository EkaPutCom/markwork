// The Preferences dialog: a setting changed in it, and the dialog closing (PreferencesController).

import { RequestError } from '../messages.js';
import type { PreferenceKey } from '../../preferences.js';
import { str, type HandlerContext } from './context.js';

export function preferencesHandlers({ wire, session }: HandlerContext): void {
    // A key or a value the dialog does not have is refused; the values the dialog shows are sent again by the controller.
    wire.on('act.prefs.set', p => {
        const value = p.value;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new RequestError('bad_request', 'value is missing');
        if (!session.preferences.set(str(p.key, 'key') as PreferenceKey, value)) throw new RequestError('bad_request', 'that is not a setting of the dialog');
    });
    wire.on('act.prefs.closed', () => { session.preferences.closed(); });
}
