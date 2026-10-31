// A folder opts in through its own marker. Configuration never grants capabilities or chooses a process.
import { readTextFile } from '../base/files';
import { platform } from '../platform/index';
import { cleanNewName } from './changes';
import { folderPath } from './path';

export interface AgentFolderConfig {
    version: 1;
    name: string;
    description: string;
    instructions: string;
}

export type AgentFolderDefinition = { kind: 'ordinary' } | { kind: 'invalid'; error: string } | {
    kind: 'agent'; config: AgentFolderConfig; instructions: string;
};

export const isAgentReserved = (name: string): boolean => name === 'chats' || name.startsWith('chats/') || name === 'agent.json';

function descriptionOf(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > 500) throw Error('Agent description must contain at most 500 characters');
    return value;
}

export function parseAgentFolder(text: string): AgentFolderConfig {
    if (text.length > 16384) throw Error('agent.json is larger than 16 KB');
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('agent.json must contain an object');
    const config = value as Record<string, unknown>;
    if (config.version !== 1) throw Error('agent.json requires version 1');
    if (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 120) throw Error('Agent name must contain 1–120 characters');
    const description = descriptionOf(config.description);
    const file = config.instructions;
    if (typeof file !== 'string' || cleanNewName(file) !== file || isAgentReserved(file) || !file.toLowerCase().endsWith('.md')) throw Error('Instructions must name a Markdown file inside the agent folder');
    return { version: 1, name: config.name.trim(), description, instructions: file };
}

export function loadAgentFolder(root: string): AgentFolderDefinition {
    const { fs, paths } = platform();
    try {
        if (fs.kind(paths.join(root, 'agent.json')) === 'missing') return { kind: 'ordinary' };
        const marker = folderPath(root, 'agent.json');
        if (fs.info(marker).size > 16384) throw Error('agent.json is larger than 16 KB');
        const config = parseAgentFolder(readTextFile(marker));
        const file = folderPath(root, config.instructions);
        if (fs.info(file).size > 32768) throw Error('Agent instructions are larger than 32 KB');
        const instructions = readTextFile(file);
        folderPath(root, 'chats');
        return { kind: 'agent', config, instructions };
    } catch (e) {
        return { kind: 'invalid', error: e instanceof Error ? e.message : String(e) };
    }
}
