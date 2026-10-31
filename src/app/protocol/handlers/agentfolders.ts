import { insideName } from '../../../base/files';
import { RequestError } from '../messages';
import { str, type HandlerContext } from './context';

export function agentFolderHandlers({ wire, session }: HandlerContext): void {
    wire.on('act.agent.sync', () => ({ state: session.agentFolders.state() }));
    wire.on('act.agent.new', () => ({ id: session.agentFolders.newChat() }));
    wire.on('act.agent.open', p => ({ opened: session.agentFolders.open(str(p.session, 'session')) }));
    wire.on('act.agent.activate', p => {
        const root = str(p.root, 'root'), workspace = session.files.root;
        if (!workspace || root !== workspace && insideName(workspace, root) === null) throw new RequestError('bad_request', 'Agent folder is outside this workspace');
        if (!session.agentFolders.activate(root)) return { opened: false };
        const state = session.agentFolders.state();
        if (state.error) return { opened: false, error: state.error };
        return { opened: state.sessions.length ? session.agentFolders.open(state.sessions[0].id) : !!session.agentFolders.newChat() };
    });
}
