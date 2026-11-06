#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const usage =
    'Usage: node scripts/line-length.mjs ' +
    '[--max N] [--summary] [--tracked | -- <file>...]';

function maximum(value) {
    if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
        throw new Error('--max requires a non-negative safe integer.');
    }
    return Number(value);
}

function parseArgs(args) {
    const options = { files: [], max: null, tracked: false, summary: false };
    let positional = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!positional && arg === '--') positional = true;
        else if (!positional && arg === '--max') {
            options.max = maximum(args[++i]);
        } else if (!positional && arg === '--tracked') options.tracked = true;
        else if (!positional && arg === '--summary') options.summary = true;
        else if (!positional && arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else options.files.push(arg);
    }
    validateOptions(options);
    return options;
}

function validateOptions(options) {
    if (options.tracked && options.files.length) {
        throw new Error('--tracked cannot be combined with file paths.');
    }
    if (!options.tracked && !options.files.length) {
        throw new Error('Provide files or use --tracked.');
    }
    if (options.tracked && options.max === null) options.max = 80;
    if (options.summary && options.max === null) {
        throw new Error('--summary requires --max or --tracked.');
    }
}

function trackedFiles() {
    const output = execFileSync(
        'git',
        ['ls-files', '-z', '--', 'src', 'electron', 'tests', 'scripts'],
        { encoding: 'utf8' }
    );
    return output.split('\0').filter((file) => {
        if (/^src\/.*\.ts$/.test(file)) return true;
        if (/^electron\/.*\.tsx?$/.test(file)) return true;
        if (/^tests\/.*\.(ts|mjs)$/.test(file)) return true;
        return /^scripts\/.*\.(js|mjs|cjs)$/.test(file);
    });
}

async function checkFile(file, max) {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    let matches = 0;
    try {
        for await (const line of lines) {
            lineNumber++;
            const length = Array.from(line).length;
            if (max === null || length > max) {
                console.log(`${file}:${lineNumber}: ${length}`);
                matches++;
            }
        }
    } finally {
        lines.close();
        input.destroy();
    }
    return max === null ? 0 : matches;
}

function printSummary(counts, checked) {
    const directories = new Map();
    let total = 0;
    for (const [file, count] of counts) {
        const dir = dirname(file).replaceAll('\\', '/');
        directories.set(dir, (directories.get(dir) ?? 0) + count);
        total += count;
    }
    console.error(`\nViolations: ${total}; files: ${counts.size}/${checked}`);
    console.error('By directory:');
    for (const [dir, count] of directories) console.error(`  ${dir}: ${count}`);
    console.error('By file:');
    for (const [file, count] of counts) console.error(`  ${file}: ${count}`);
}

async function main() {
    if (process.argv.length === 3 && process.argv[2] === '--help') {
        console.log(
            `${usage}\n` +
                'Counts Unicode code points, excluding line endings.\n' +
                '--tracked checks scoped Git files (default maximum: 80).\n' +
                '--summary writes violation counts to stderr.\n' +
                'Exit status: 0 success, 1 violations, 2 argument or file error.'
        );
        return;
    }
    const options = parseArgs(process.argv.slice(2));
    const files = options.tracked ? trackedFiles() : options.files;
    const counts = new Map();
    for (const file of files) {
        try {
            const count = await checkFile(file, options.max);
            if (count) {
                counts.set(file, (counts.get(file) ?? 0) + count);
                process.exitCode ||= 1;
            }
        } catch (error) {
            console.error(`${file}: ${error.message}`);
            process.exitCode = 2;
        }
    }
    if (options.summary) printSummary(counts, files.length);
}

main().catch((error) => {
    console.error(`${error.message}\n${usage}`);
    process.exitCode = 2;
});
