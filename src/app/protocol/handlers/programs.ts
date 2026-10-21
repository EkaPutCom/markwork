// The Programs page and Home's Set up section: what the user did there (ProgramsController).

import { str, type HandlerContext } from './context.js';

export function programsHandlers({ wire, session }: HandlerContext): void {
    wire.on('act.programs.open', () => { session.documents.openPrograms(); });
    wire.on('act.programs.check', () => { void session.programs.check(); });
    wire.on('act.programs.hideSetup', () => { session.programs.hideSetup(); });
    wire.on('act.programs.runHere', () => { session.programs.runHere(); });
    // The machine is one the page was given; any other name is not a machine of the settings and opens nothing.
    wire.on('act.programs.openTerminal', p => { session.programs.openTerminal(p.machine === null || p.machine === undefined ? null : str(p.machine, 'machine')); });
    wire.on('act.programs.openSite', p => { session.programs.openSite(str(p.name, 'name')); });
}
