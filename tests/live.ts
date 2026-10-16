// Live tests against the real DeepSeek API (needs internet and a key; paid but very cheap). NOT part of npm test.
//
//   npm run test:live                  key from .env (DEEPSEEK_API_KEY), without thinking mode
//   npm run test:live -- --thinking    with thinking mode
//   npm run test:live -- --model=deepseek-v4-pro
//   npm run test:live -- --commit-only  only the commit message writer (tests/live-commit.ts)
//   npm run test:live -- --structured    also the tools for structured documents (tests/live-structured.ts)
//   npm run test:live -- --structured-only  only those
//
// Uses the manuscript tests/samples/sample-book (deliberately containing contradictions: Raka's age 17 vs 25, the name Hasan vs Hasyim,
// white vs black ship) and runs ChatSession + DeepSeek + the same browsing tools as the app.
// The key is never printed.

import '../src/platform/gjs/install.js';   // the core reaches the runtime through platform()
import './host-gjs.js';   // the tests reach the runtime through host(), installed before framework.ts
import { liveAgentic } from './live-agentic.js';
import { liveCommitMessage } from './live-commit.js';
import { liveStructured } from './live-structured.js';
import GLib from 'gi://GLib';
import System from 'system';
import { systemKeyStore } from '../src/agent/apikey.js';
import { DEEPSEEK_MODELS, DeepSeek } from '../src/agent/deepseek.js';
import { DEFAULT_BUDGET } from '../src/agent/context.js';
import { WorkspaceRepository } from '../src/workspace.js';
import { ChatSession } from '../src/agent/session.js';
import { DIM, GREEN, RED, RESET, ROOT, optVal, opt, setRoot } from './framework.js';

setRoot(import.meta.url);

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

interface Scenario {
    name: string;
    question: string;
    minTools: number;
    mustMention: RegExp[];
    budget?: number;   // initial context budget; very small = the model is forced to browse with tools
    cite?: RegExp;   // the quoted line number (file.md:N) must point to a line containing this pattern
}

const SCENARIOS: Scenario[] = [
    { name: 'summarize the open document (no tools)', question: 'Summarize this document in three points.', minTools: 0, mustMention: [/storm/i] },
    { name: 'a character across the whole book', question: 'Who is Hasan and what is his role in this whole book? Give the file and line numbers.', minTools: 0, mustMention: [/captain/i], cite: /hasan|hasyim|captain/i },
    { name: 'contradictions (the initial context is enough)', question: 'Are there contradictions about the age of Raka or about the ship in this book? Give the file and its lines.', minTools: 0, mustMention: [/17|seventeen/i, /25|twenty-five/i], cite: /raka|ship|hull|sail|hasan|hasyim|captain|seagull/i },
    // A budget of 900 tokens is only enough for the instructions: there is no manuscript in the initial context, so the answer can only come from tools.
    { name: 'contradictions without initial context (tools required)', question: 'Are there contradictions about the age of Raka or about the ship in this book? Give the file and its lines.', minTools: 1, budget: 900,
        mustMention: [/17|seventeen/i, /25|twenty-five/i], cite: /raka|ship|hull|sail|hasan|hasyim|captain|seagull/i },
];

async function main(): Promise<boolean> {
    const found = await systemKeyStore.get();
    if (!found?.key) {
        print(`${RED}No API key. Set DEEPSEEK_API_KEY in .env (see .env.example), then run npm run test:live.${RESET}`);
        return false;
    }

    const root = GLib.build_filenamev([ROOT, 'tests', 'samples', 'sample-book']);
    const book = new WorkspaceRepository().files(root);
    if (!book.length) {
        print(`${RED}The sample manuscript was not found in  ${root}${RESET}`);
        return false;
    }
    const activeName = 'chapter-2.md';
    const activeText = book.find(f => f.name === activeName)!.text;
    const files = book.filter(f => f.name !== activeName);

    const model = optVal('model') ?? DEEPSEEK_MODELS[0];
    const thinking = opt('thinking');
    const provider = new DeepSeek(found.key);
    print(`${DIM}Model ${model}, thinking ${thinking ? 'on' : 'off'}, key from ${found.source}, ${book.length} files${RESET}`);

    let failures = 0;
    if (opt('commit-only')) return await liveCommitMessage(provider, model) === 0;
    if (opt('structured-only')) return await liveStructured(provider, model, thinking) === 0;
    for (const sc of SCENARIOS) {
        print(`\n▶ ${sc.name}\n  Q: ${sc.question}`);
        const session = new ChatSession();
        session.thinking = thinking;
        const started = GLib.get_monotonic_time();
        try {
            const r = await session.ask({
                question: sc.question, active: { name: activeName, text: activeText, cursorLine: 4 }, selection: '', files, mentions: [],
                options: { activeDocument: true, selection: true, project: true }, budget: sc.budget ?? DEFAULT_BUDGET,
            }, provider, model, {
                onContext: b => print(`  ${DIM}context ≈${b.tokens} tokens${RESET}`),
                onText: () => {},
                onReasoning: () => {},
                onTool: s => { if (s.summary) print(`  ${DIM}• ${s.label} → ${s.summary}${RESET}`); },
            });
            const secs = ((GLib.get_monotonic_time() - started) / 1e6).toFixed(1);
            print(`  A: ${r.text.trim().split('\n').join('\n     ')}`);
            print(`  ${DIM}${secs} s · ${r.toolCalls} lookups · ${r.usage ? `${r.usage.prompt} in (${r.usage.cached} cached) / ${r.usage.completion} out` : 'no usage'}${RESET}`);
            const problems: string[] = [];
            if (!r.text.trim()) problems.push('empty answer');
            if (r.toolCalls < sc.minTools) problems.push(`tools called ${r.toolCalls}x, expected ≥ ${sc.minTools}`);
            for (const re of sc.mustMention) if (!re.test(r.text)) problems.push(`the answer does not mention ${re}`);
            if (sc.cite) {
                // A location citation such as `chapter-2.md:7` must point to a line that really exists and is relevant (against invented numbers).
                const cites = [...r.text.matchAll(/(chapter-\d\.md)[:` ]*(?:line\s*)?:?(\d+)/g)];
                for (const [, name, n] of cites) {
                    const line = book.find(f => f.name === name)?.text.split('\n')[Number(n) - 1] ?? '';
                    if (!sc.cite.test(line)) problems.push(`the citation ${name}:${n} points to the wrong line (“${line.slice(0, 40)}”)`);
                }
                if (!cites.length) problems.push('no line number citation');
            }
            if (problems.length) { failures++; print(`  ${RED}✗ ${problems.join('; ')}${RESET}`); }
            else print(`  ${GREEN}✓ passed${RESET}`);
        } catch (e) {
            failures++;
            print(`  ${RED}✗ error:  ${errorMessage(e)}${RESET}`);
        }
    }
    print(`\n${failures ? RED : GREEN}${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios passed${RESET}`);
    failures += await liveCommitMessage(provider, model);
    if (opt('agentic')) failures += await liveAgentic(provider, model, thinking);
    if (opt('structured')) failures += await liveStructured(provider, model, thinking);
    return failures === 0;
}

const loop = new GLib.MainLoop(null, false);
let ok = false;
main().then(r => { ok = r; }, e => { print(`${RED}${errorMessage(e)}${RESET}`); }).finally(() => loop.quit());
loop.run();
System.exit(ok ? 0 : 1);
