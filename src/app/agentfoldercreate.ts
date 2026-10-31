// A user-created agent starts as a complete definition; unfinished files stay out of the visible tree.
import { platform } from '../platform/index';
import { insideName, writeTextFile } from '../base/files';
import { renameEntry } from '../base/fileops';
import { folderPath } from '../agent/path';

function folderName(raw: string): string {
    const name = raw.trim();
    if (!name || name.length > 120) throw Error('Agent folder name must contain 1–120 characters.');
    if (name.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name.endsWith('.')) throw Error('Use a visible folder name without path separators or reserved characters.');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw Error('That folder name is reserved. Choose another name.');
    return name;
}

function parentFolder(workspace: string, parent: string): string {
    const { fs, paths } = platform();
    const relative = insideName(workspace, parent);
    if (!paths.same(workspace, parent) && relative === null) throw Error('Choose a parent folder inside the current workspace.');
    const safe = relative ? folderPath(workspace, relative) : workspace;
    if (!fs.isDirectory(safe)) throw Error('The parent folder is no longer available.');
    return safe;
}

function discardStage(stage: string, files: string[]): void {
    const { fs, paths } = platform();
    try {
        if (fs.kind(stage) !== 'directory') return;
        for (const file of files) {
            const path = folderPath(stage, file);
            if (fs.kind(path) !== 'missing') fs.remove(path);
        }
        fs.remove(paths.join(stage, 'chats'));
        fs.remove(stage);
    } catch { /* Keep unexpected contents rather than recursively deleting them. */ }
}

export function createAgentFolder(workspace: string, parent: string, rawName: string): string {
    const name = folderName(rawName), dir = parentFolder(workspace, parent);
    const { fs, paths } = platform();
    const target = folderPath(dir, name);
    if (fs.kind(target) !== 'missing') throw Error(`“${name}” already exists in this folder.`);
    const stage = paths.join(dir, '.markwork-new-agent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    if (fs.kind(stage) !== 'missing') throw Error('Could not reserve a temporary folder. Try again.');
    const files = {
        'agent.json': JSON.stringify({ version: 1, name, instructions: 'instructions.md' }, null, 4) + '\n',
        'instructions.md': `# ${name}\n\nHelp with the documents in this folder.\n\n- Read the relevant files before answering.\n- Cite file names and line numbers for factual claims.\n- Explain uncertainty when information is missing.\n- Propose file changes for review and wait for the user to press Apply.\n`,
        'chats/.gitignore': '*\n',
    };
    try {
        fs.makeDirs(paths.join(stage, 'chats'), 0o755);
        for (const [file, text] of Object.entries(files)) writeTextFile(folderPath(stage, file), text);
        renameEntry(stage, name);
        return target;
    } finally { discardStage(stage, Object.keys(files)); }
}
