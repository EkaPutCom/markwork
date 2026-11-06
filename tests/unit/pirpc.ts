import { PiRpc, discoverPi } from '../../src/agent/pirpc';
import { FolderStore } from '../../src/agent/folderstore';
import { serializeChat } from '../../src/agent/transcript';
import { AgentTrace, MAX_EVENTS } from '../../src/agent/trace';
import { fakeFolderPi } from './fakefolderpi';
import {
    platform,
    type ChildHandlers,
    type Processes,
} from '../../src/platform/index';
import { section, test, eq, ok, tmp, disk, say } from '../core/framework';

export async function piRpcTests(): Promise<void> {
    section('Shared pi RPC transport');
    await test('local discovery accepts installed pi without probing its version and still rejects missing pi', async () => {
        const processes = platform().processes,
            find = processes.findProgram,
            run = processes.run;
        try {
            processes.findProgram = () => 'installed-pi';
            processes.run = async () => {
                throw Error('Discovery must not run a version probe');
            };
            eq(await discoverPi(), 'installed-pi');
            processes.findProgram = () => null;
            let message = '';
            try {
                await discoverPi();
            } catch (error) {
                message = String(error);
            }
            ok(
                message.includes('pi is not installed'),
                'missing pi was accepted'
            );
        } finally {
            processes.findProgram = find;
            processes.run = run;
        }
    });
    await test('native prompt completion before acknowledgement is observed and agent_end alone is not terminal', async () => {
        let handlers!: ChildHandlers,
            settled = false;
        const writes: string[] = [];
        const spawn: Processes['spawn'] = (_argv, _cwd, value) => {
            handlers = value;
            return {
                write(line) {
                    const command = JSON.parse(line);
                    writes.push(command.type);
                    handlers.line(
                        JSON.stringify({
                            type: 'response',
                            id: command.id,
                            success: true,
                            data: { disposition: 'started' },
                        })
                    );
                    handlers.line('{"type":"agent_end"}');
                    return true;
                },
                closeInput: () => handlers.exit(0, ''),
                stop: () => handlers.exit(143, ''),
            };
        };
        const rpc = new PiRpc(['fake'], tmp, spawn);
        try {
            const turn = rpc.prompt('hello').then(() => {
                settled = true;
            });
            await Promise.resolve();
            eq(settled, false);
            handlers.line('{"type":"agent_settled","aborted":false}');
            await turn;
            eq(settled, true);
            eq(writes, ['prompt']);
        } finally {
            await rpc.close();
        }
    });
    await test('responses correlate out of order; malformed records and process exits reject pending work', async () => {
        let handlers!: ChildHandlers;
        const ids: string[] = [];
        const spawn: Processes['spawn'] = (_argv, _cwd, value) => {
            handlers = value;
            return {
                write: (line) => {
                    ids.push(JSON.parse(line).id);
                    return true;
                },
                closeInput: () => handlers.exit(0, ''),
                stop: () => handlers.exit(143, ''),
            };
        };
        const rpc = new PiRpc(['fake'], tmp, spawn);
        try {
            const a = rpc.command('a'),
                b = rpc.command('b');
            handlers.line(
                JSON.stringify({
                    type: 'response',
                    id: ids[1],
                    success: true,
                    data: { answer: 'b' },
                })
            );
            handlers.line(
                JSON.stringify({
                    type: 'response',
                    id: ids[0],
                    success: true,
                    data: { answer: 'a' },
                })
            );
            eq([(await a).answer, (await b).answer], ['a', 'b']);
            const pending = rpc.command('pending');
            handlers.line('invalid JSON');
            let rejected = false;
            try {
                await pending;
            } catch {
                rejected = true;
            }
            ok(rejected, 'malformed stream accepted');
        } finally {
            await rpc.close();
        }
    });
    await test('unknown acknowledgements time out without resending and failure propagates to active prompts', async () => {
        let handlers!: ChildHandlers,
            calls = 0;
        const spawn: Processes['spawn'] = (_argv, _cwd, value) => {
            handlers = value;
            return {
                write: () => {
                    calls++;
                    return true;
                },
                closeInput: () => handlers.exit(0, ''),
                stop: () => handlers.exit(143, ''),
            };
        };
        const rpc = new PiRpc(['fake'], tmp, spawn);
        try {
            let rejected = false;
            try {
                await rpc.command('silent', {}, 20);
            } catch {
                rejected = true;
            }
            ok(rejected, 'unbounded acknowledgement');
            eq(calls, 1);
            const prompt = rpc.prompt('Never repeat');
            handlers.exit(1, 'fixture exit');
            rejected = false;
            try {
                await prompt;
            } catch {
                rejected = true;
            }
            ok(rejected, 'lost process was completion');
        } finally {
            await rpc.close();
        }
    });
    await test('Stop clears queued pi input before abort; oversized output and input backpressure fail closed', async () => {
        let handlers!: ChildHandlers,
            blocked = false;
        const writes: string[] = [];
        const spawn: Processes['spawn'] = (_argv, _cwd, value) => {
            handlers = value;
            return {
                write(line) {
                    const command = JSON.parse(line);
                    writes.push(command.type);
                    if (blocked) return false;
                    if (command.type === 'abort')
                        handlers.line(
                            '{"type":"agent_settled","aborted":true}'
                        );
                    handlers.line(
                        JSON.stringify({
                            type: 'response',
                            id: command.id,
                            success: true,
                            data: { disposition: 'started' },
                        })
                    );
                    return true;
                },
                closeInput: () => handlers.exit(0, ''),
                stop: () => handlers.exit(143, ''),
            };
        };
        const rpc = new PiRpc(['fake'], tmp, spawn);
        try {
            const turn = rpc.prompt('work');
            await rpc.stop();
            eq(await turn, true);
            eq(writes, ['prompt', 'clear_queue', 'abort']);
            blocked = true;
            let failed = false;
            try {
                await rpc.command('pressure');
            } catch {
                failed = true;
            }
            ok(failed, 'backpressure ignored');
        } finally {
            await rpc.close();
        }
        const other = new PiRpc(['fake'], tmp, spawn);
        try {
            blocked = false;
            const turn = other.prompt('work');
            handlers.line('x'.repeat(8 * 1024 * 1024 + 1));
            let failed = false;
            try {
                await turn;
            } catch {
                failed = true;
            }
            ok(failed, 'record limit ignored');
        } finally {
            await other.close();
        }
    });
    await test('a synchronous settled event before the prompt acknowledgement is retained', async () => {
        const spawn: Processes['spawn'] = (_argv, _cwd, handlers) => ({
            write(line) {
                const command = JSON.parse(line);
                handlers.line('{"type":"agent_settled","aborted":false}');
                handlers.line(
                    JSON.stringify({
                        type: 'response',
                        id: command.id,
                        success: true,
                        data: { disposition: 'started' },
                    })
                );
                return true;
            },
            closeInput: () => handlers.exit(0, ''),
            stop: () => handlers.exit(143, ''),
        });
        const rpc = new PiRpc(['fake'], tmp, spawn);
        try {
            eq(await rpc.prompt('work'), false);
        } finally {
            await rpc.close();
        }
    });
    await test('the adapter accepts LF records containing Unicode separators without splitting them again', async () => {
        const fake = fakeFolderPi(),
            id = platform().newId(),
            dir = disk.join(tmp, 'pi-unicode');
        disk.mkdirs(dir);
        disk.write(disk.join(dir, 'instructions.md'), 'Test');
        const rpc = new PiRpc(
            [
                'fake',
                '--session-id',
                id,
                '--session-dir',
                dir,
                '--append-system-prompt',
                disk.join(dir, 'instructions.md'),
            ],
            dir,
            fake.spawn
        );
        try {
            await rpc.prompt('a\u2028b\u2029🌱');
            const messages = (await rpc.command('get_messages')).messages;
            eq(messages[0].content, 'a\u2028b\u2029🌱');
        } finally {
            await rpc.close();
        }
    });
    await folderPiMeasurement();
}

async function folderPiMeasurement(): Promise<void> {
    await test('folder pi measurement: 200 bindings, native-history projection, 1,000 RPC events and bounded logs', async () => {
        const id = platform().newId(),
            root = disk.join(tmp, 'pi-measure-' + id);
        const config = {
            version: 2 as const,
            id,
            name: 'Measurement',
            description: '',
            runtime: 'pi' as const,
            instructions: 'instructions.md',
        };
        disk.mkdirs(root);
        disk.mkdirs(disk.join(root, 'chats'));
        const store = new FolderStore(root, config);
        disk.mkdirs(store.directory);
        const view = {
            title: 'Measurement',
            model: 'fake/test',
            created: '2026-11-01',
            turns: [
                { role: 'user' as const, content: 'A source question' },
                {
                    role: 'assistant' as const,
                    content: 'A source passage.\n'.repeat(1000),
                },
            ],
        };
        const text = serializeChat(view),
            hash = platform().hash(text);
        const chats = Array.from({ length: 200 }, () => ({
            id: platform().newId(),
            title: 'Measurement',
            created: view.created,
            native: null,
            projectionHash: hash,
            status: 'idle',
        }));
        for (const chat of chats)
            disk.write(disk.join(root, 'chats', chat.id + '.md'), text);
        disk.write(
            disk.join(store.directory, 'index.json'),
            JSON.stringify({ version: 1, root, chats })
        );
        const times: Record<string, number[]> = {
            load200: [],
            list200: [],
            switchView: [],
            project18KB: [],
            turnProvenance: [],
            rpc1000: [],
        };
        let handlers!: ChildHandlers,
            events = 0;
        const spawn: Processes['spawn'] = (_argv, _cwd, value) => {
            handlers = value;
            return {
                write: () => true,
                closeInput: () => handlers.exit(0, ''),
                stop: () => handlers.exit(143, ''),
            };
        };
        const rpc = new PiRpc(['fake'], root, spawn),
            off = rpc.onEvent(() => {
                events++;
            });
        const line = JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'Research 🌱' },
        });
        try {
            for (let n = 0; n < 23; n++) {
                let start = platform().monotonicMs();
                const loaded = new FolderStore(root, config);
                measure(times.load200, start, n);
                start = platform().monotonicMs();
                eq(loaded.list().length, 200);
                measure(times.list200, start, n);
                start = platform().monotonicMs();
                eq(loaded.view(chats[n].id).turns.length, 2);
                measure(times.switchView, start, n);
                start = platform().monotonicMs();
                loaded.project(chats[n].id, view);
                measure(times.project18KB, start, n);
                loaded.update(chats[n].id, {
                    native: disk.join(
                        store.directory,
                        'sessions',
                        chats[n].id + '.jsonl'
                    ),
                    instructionRevision: hash,
                });
                start = platform().monotonicMs();
                loaded.recordTurn(chats[n].id);
                measure(times.turnProvenance, start, n);
                loaded.release();
                start = platform().monotonicMs();
                for (let i = 0; i < 1000; i++) handlers.line(line);
                measure(times.rpc1000, start, n);
            }
            eq(events, 23000);
            const trace = new AgentTrace();
            for (let i = 0; i < 3000; i++) trace.add('text', 'retained event');
            eq(trace.events.length, MAX_EVENTS);
            say(
                '  Folder pi baseline (ms, 3 warmups + 20 repetitions): ' +
                    JSON.stringify(
                        Object.fromEntries(
                            Object.entries(times).map(([name, values]) => {
                                values.sort((a, b) => a - b);
                                return [
                                    name,
                                    {
                                        median: values[10],
                                        p95: values[18],
                                        max: values[19],
                                    },
                                ];
                            })
                        )
                    )
            );
        } finally {
            off();
            await rpc.close();
        }
    });
}
function measure(values: number[], start: number, n: number): void {
    if (n >= 3) values.push(platform().monotonicMs() - start);
}
