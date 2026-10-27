// The command table (app/commands.ts) and the tokens of toasts: what the core carries out when the frontend asks
// (docs/design/protocol.md, sections 6.4 and 8).

import { COMMANDS, type FrontendCommands } from '../../commands';
import { RequestError } from '../messages';
import { unwired } from '../unwired';
import { num, type HandlerContext } from './context';

// The editor's own commands never reach the core; session.commands() wants the frontend's half, which has nothing to do here.
const NO_FRONTEND_COMMANDS = unwired<FrontendCommands>({}, 'frontendCommands');

// The table as the frontend gets it in the `hello` reply: everything but the code that runs a command.
export const commandTable = () => COMMANDS.map(({ id, label, keys, kind, scope, runs, ownsState }) =>
    ({ id, label: label ?? null, keys: [...keys], kind, scope, runs, ownsState: ownsState === true }));

export function commandHandlers({ wire, session }: HandlerContext): void {
    wire.on('act.token', p => { session.toastActivated(num(p.token, 'token')); });
    // A command of the table that the core carries out; the editor's own (`runs: "editor"`) never get here.
    wire.on('command', async p => {
        const command = COMMANDS.find(c => c.id === p.name && c.runs === 'core');
        if (!command) throw new RequestError('unknown_command', `no such command: ${String(p.name)}`);
        await command.run(session.commands(NO_FRONTEND_COMMANDS), p.arg as boolean | string | undefined);
    });
}
