import { insideName } from '../../../base/files';
import { RequestError } from '../messages';
import { str, type HandlerContext } from './context';

export function agentFolderHandlers({ wire, session }: HandlerContext): void {
    wire.on('act.agent.sync', () => ({ state: session.agentFolders.state() }));
    wire.on('act.agent.enable', async (p) => ({
        enabled: await session.agentFolders.enable(str(p.root, 'root')),
    }));
    wire.on('act.agent.execution', async (p) => {
        if (p.mode !== 'local' && p.mode !== 'background')
            throw new RequestError(
                'bad_request',
                'Choose local or background execution'
            );
        await session.agentFolders.execution(str(p.root, 'root'), p.mode);
        return {};
    });
    wire.on('act.agent.reconnect', async (p) => {
        const root = str(p.root, 'root');
        if (root !== session.agentFolders.state().root)
            throw new RequestError(
                'bad_request',
                'Select this agent before reconnecting'
            );
        await session.agentFolders.reconnect(root);
        return {};
    });
    wire.on('act.agent.stopOriginal', async (p) => {
        await session.agentFolders.stopOriginal(str(p.session, 'session'));
        return {};
    });
    wire.on('act.agent.recover', async (p) => {
        await session.agentFolders.recover(str(p.session, 'session'));
        return {};
    });
    wire.on('act.agent.resolve', async (p) => {
        if (p.choice !== 'reload' && p.choice !== 'keep')
            throw new RequestError('bad_request', 'Choose reload or keep');
        await session.agentFolders.resolve(str(p.path, 'path'), p.choice);
        return {};
    });
    wire.on('act.agent.new', () => ({ id: session.agentFolders.newChat() }));
    wire.on('act.agent.open', (p) => ({
        opened: session.agentFolders.open(str(p.session, 'session')),
    }));
    wire.on('act.agent.activate', (p) => {
        const root = str(p.root, 'root'),
            workspace = session.files.root;
        if (
            !workspace ||
            (root !== workspace && insideName(workspace, root) === null)
        )
            throw new RequestError(
                'bad_request',
                'Agent folder is outside this workspace'
            );
        if (!session.agentFolders.activate(root)) return { opened: false };
        const state = session.agentFolders.state();
        if (state.error) return { opened: false, error: state.error };
        return {
            opened: state.sessions.length
                ? session.agentFolders.open(state.sessions[0].id)
                : !!session.agentFolders.newChat(),
        };
    });
}
