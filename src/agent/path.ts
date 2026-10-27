// Name validation plus symlink rejection so that writes stay inside the project folder.
import { platform } from '../platform/index';
import { cleanNewName } from './changes';

export function projectPath(root: string, file: string): string {
    if (cleanNewName(file) !== file) throw Error('path is outside the work folder or invalid');
    const { fs, paths } = platform();
    let current = root;
    for (const part of file.split('/')) {
        current = paths.join(current, part);
        // A part that does not exist yet is fine (a new file or folder); anything that cannot be checked throws.
        if (fs.kind(current) === 'symlink') throw Error('path goes through a symbolic link outside the agent access boundary');
    }
    return current;
}
