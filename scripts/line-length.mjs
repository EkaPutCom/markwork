#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const usage = 'Usage: node scripts/line-length.mjs [--max N] [--] <file>...';

function parseArgs(args) {
    const files = [];
    let max = null;
    let positional = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!positional && arg === '--') {
            positional = true;
        } else if (!positional && arg === '--max') {
            const value = args[++i];
            if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
                throw new Error('--max requires a non-negative safe integer.');
            }
            max = Number(value);
        } else if (!positional && arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`);
        } else {
            files.push(arg);
        }
    }
    if (!files.length) throw new Error('Provide at least one file.');
    return { files, max };
}

async function checkFile(file, max) {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    let exceeded = false;
    try {
        for await (const line of lines) {
            lineNumber++;
            const length = Array.from(line).length;
            if (max === null || length > max) {
                console.log(`${file}:${lineNumber}: ${length}`);
                exceeded = true;
            }
        }
    } finally {
        lines.close();
        input.destroy();
    }
    return max !== null && exceeded;
}

async function main() {
    if (process.argv.slice(2).includes('--help')) {
        console.log(`${usage}\nCounts Unicode code points (not display width), excluding line endings.\nWith --max, prints only lines exceeding N and exits with status 1.\nExit status 2 indicates an argument or file error.`);
        return;
    }
    const { files, max } = parseArgs(process.argv.slice(2));
    for (const file of files) {
        try {
            if (await checkFile(file, max)) process.exitCode ||= 1;
        } catch (error) {
            console.error(`${file}: ${error.message}`);
            process.exitCode = 2;
        }
    }
}

main().catch(error => {
    console.error(`${error.message}\n${usage}`);
    process.exitCode = 2;
});
