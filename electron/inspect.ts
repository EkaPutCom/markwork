// The Editor Inspector's bridge in the main process (docs/design/debugger.md, section 8): a socket that answers JSON, one
// message per line, for scripts/editor.mjs. Reading is passed to the page (renderer/lib/inspect/bridge.ts); keys and
// clicks are sent from here as real input (webContents.sendInputEvent), through Chromium's input path, so the keymap, the
// event handlers, and the recorder see them as they see a person's. Loaded only in dev mode (main.ts).

import { BrowserWindow, ipcMain, type KeyboardInputEvent, type WebContents } from 'electron';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userDirs } from '../src/platform/node/dirs.js';
import type { OS } from '../src/platform/index.js';

type Message = Record<string, unknown>;

const PAGE_TIMEOUT_MS = 15_000;
const MAX_LINE = 4 * 1024 * 1024;   // a repro with a long text fits; a stream without line breaks does not grow forever

// Where the socket of this process is: a folder only this user can enter, as markworkd's (docs/design/markworkd.md).
export function socketPath(pid = process.pid): string {
    if (process.platform === 'win32') return `\\\\.\\pipe\\markwork-inspect-${pid}`;
    return join(socketFolder(), `inspect-${pid}.sock`);
}
export const socketFolder = (): string => join(userDirs(process.platform as OS, process.env, homedir(), join).runtime, 'markwork');

class UsageError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

// ---------- Input ----------

// The DOM's names of keys (what the recorder writes) to Electron's.
const KEY_NAMES: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Esc: 'Escape', Return: 'Enter', Del: 'Delete',
};
type Modifier = NonNullable<KeyboardInputEvent['modifiers']>[number];

// "Ctrl+Shift+z", "Mod+b" (Cmd on macOS, Ctrl elsewhere: CodeMirror's Mod), "Backspace", "ArrowDown".
export function parseKey(combo: string): { keyCode: string; modifiers: Modifier[]; text: string | null } {
    const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/);
    const name = parts.pop()!;
    const modifiers: Modifier[] = [];
    for (const part of parts) {
        const m = part.toLowerCase();
        if (m === 'ctrl' || m === 'control') modifiers.push('control');
        else if (m === 'mod') modifiers.push(process.platform === 'darwin' ? 'meta' : 'control');
        else if (m === 'meta' || m === 'cmd' || m === 'command') modifiers.push('meta');
        else if (m === 'alt' || m === 'option') modifiers.push('alt');
        else if (m === 'shift') modifiers.push('shift');
        else throw new UsageError('usage', `${combo}: ${part} is not a modifier (Ctrl, Mod, Meta, Alt, Shift)`);
    }
    const keyCode = KEY_NAMES[name] ?? name;
    const printable = [...name].length === 1;
    // A capital letter is typed with Shift down, so the key the page sees is the capital too.
    if (/^[A-Z]$/.test(name) && !modifiers.includes('shift')) modifiers.push('shift');
    // A character is typed only when no modifier makes it a shortcut (Shift is already in the character).
    const text = printable && !modifiers.some(m => m !== 'shift') ? name : null;
    return { keyCode, modifiers, text };
}

function press(contents: WebContents, combo: string): void {
    const { keyCode, modifiers, text } = parseKey(combo);
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (text !== null) contents.sendInputEvent({ type: 'char', keyCode: text, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function typeText(contents: WebContents, text: string): void {
    for (const char of text) {
        if (char === '\n') press(contents, 'Enter');
        else if (char === '\t') press(contents, 'Tab');
        // A letter a keyboard has goes down and up; any other is only the character it types.
        else if (/^[\x20-\x7e]$/.test(char)) press(contents, char);
        else contents.sendInputEvent({ type: 'char', keyCode: char });
    }
}

function click(contents: WebContents, x: number, y: number, mods: string | undefined): void {
    const modifiers = mods ? parseKey(`${mods}+x`).modifiers : [];
    contents.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1, modifiers });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1, modifiers });
}

// ---------- The bridge ----------

const READ_OPS = new Set(['snapshot', 'decorations', 'log', 'check', 'last', 'open', 'mode', 'load']);
const ACT_OPS = new Set(['press', 'type', 'click', 'select', 'apply']);

export class InspectBridge {
    private server: Server | null = null;
    private next = 1;
    private readonly waiting = new Map<number, (reply: Message) => void>();
    // The pages that answer (the page tells once its half is listening): before that a request would go unheard.
    private readonly ready = new WeakSet<WebContents>();

    constructor(private readonly window: () => BrowserWindow | null) {
        ipcMain.on('inspect-ready', event => { this.ready.add(event.sender); });
        ipcMain.on('inspect-reply', (event, reply: Message) => {
            const win = this.window();
            if (!win || event.sender !== win.webContents) return;
            const done = this.waiting.get(reply?.id as number);
            if (done) { this.waiting.delete(reply.id as number); done(reply); }
        });
    }

    start(): string {
        const path = socketPath();
        if (process.platform !== 'win32') {
            mkdirSync(socketFolder(), { recursive: true, mode: 0o700 });
            chmodSync(socketFolder(), 0o700);
            rmSync(path, { force: true });
        }
        this.server = createServer(socket => this.serve(socket));
        this.server.listen(path, () => { if (process.platform !== 'win32') chmodSync(path, 0o600); });
        return path;
    }

    stop(): void {
        this.server?.close();
        if (process.platform !== 'win32') rmSync(socketPath(), { force: true });
    }

    private serve(socket: Socket): void {
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('error', () => socket.destroy());
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > MAX_LINE) { socket.destroy(); return; }
            for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) void this.handle(line).then(reply => { if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`); });
            }
        });
    }

    private async handle(line: string): Promise<Message> {
        let request: Message;
        try { request = JSON.parse(line) as Message; } catch { return { re: null, ok: false, error: { code: 'usage', message: 'not a JSON line' } }; }
        const re = request.id ?? null;
        try {
            return { re, ok: true, ...await this.run(request) };
        } catch (e) {
            const error = e instanceof UsageError ? { code: e.code, message: e.message } : { code: 'internal', message: String(e) };
            return { re, ok: false, error };
        }
    }

    // Asks the page; its answer or its error comes back as it gave it.
    private async page(request: Message): Promise<Message> {
        const win = this.window();
        if (!win || win.isDestroyed()) throw new UsageError('no-window', 'the window is not open');
        if (!this.ready.has(win.webContents)) throw new UsageError('not-ready', 'the page is still loading');
        const id = this.next++;
        const reply = await new Promise<Message>((resolve, reject) => {
            const timer = setTimeout(() => { this.waiting.delete(id); reject(new UsageError('timeout', `the page did not answer ${String(request.op)} within ${PAGE_TIMEOUT_MS} ms`)); }, PAGE_TIMEOUT_MS);
            this.waiting.set(id, answer => { clearTimeout(timer); resolve(answer); });
            win.webContents.send('inspect', { ...request, id });
        });
        const { id: _id, ok, error, ...rest } = reply;
        if (!ok) {
            const e = error as { code?: string; message?: string } | undefined;
            throw new UsageError(e?.code ?? 'internal', e?.message ?? 'the page failed');
        }
        return rest;
    }

    private async run(request: Message): Promise<Message> {
        const op = String(request.op ?? '');
        if (op === 'hello') {
            const win = this.window();
            return { pid: process.pid, electron: process.versions.electron, platform: process.platform, ready: !!win && this.ready.has(win.webContents) };
        }
        if (op === 'repro') {
            const answer = await this.page(request);
            const repro = answer.repro as { app: Message };
            repro.app = { ...repro.app, electron: process.versions.electron, os: process.platform };
            return answer;
        }
        if (op === 'screenshot') return this.screenshot(request);
        if (!ACT_OPS.has(op)) {
            if (!READ_OPS.has(op)) throw new UsageError('usage', `no such op: ${op}`);
            return this.page(request);
        }
        return this.act(op, request);
    }

    // An action, then a wait until the editor has settled; with `explain`, the transactions it made and their findings.
    private async act(op: string, request: Message): Promise<Message> {
        const win = this.window();
        if (!win || win.isDestroyed()) throw new UsageError('no-window', 'the window is not open');
        const contents = win.webContents;
        const { n: before } = await this.page({ op: 'last' });
        win.focus();
        contents.focus();
        if (op === 'press' || op === 'type') await this.page({ op: 'focus' });
        let extra: Message = {};
        if (op === 'press') {
            const keys = request.keys;
            if (!Array.isArray(keys) || !keys.length || !keys.every(k => typeof k === 'string' && k)) throw new UsageError('usage', 'press needs one key or more');
            for (const key of keys as string[]) parseKey(key);   // a wrong name fails before any key goes down
            for (const key of keys as string[]) press(contents, key);
        } else if (op === 'type') {
            if (typeof request.text !== 'string') throw new UsageError('usage', 'type needs the text');
            typeText(contents, request.text);
        } else if (op === 'click') {
            const place = await this.page({ op: 'coords', visible: request.visible, edge: request.edge, pos: request.pos, cp: request.cp });
            click(contents, place.x as number, place.y as number, typeof request.mods === 'string' ? request.mods : undefined);
            extra = { at: place.pos };
        } else {
            extra = await this.page(request);
        }
        const settled = await this.page({ op: 'settle', since: before, quiet: request.quiet });
        const entries = settled.entries as { findings: { severity: string }[] | null }[];
        const failed = entries.some(e => e.findings?.some(f => f.severity === 'fail'));
        const { entries: _entries, ...where } = settled;
        return { ...where, ...extra, failed, ...(request.explain === true ? { entries } : { transactions: entries.length }) };
    }

    // A picture of the editor's area as PNG (base64), with its widgets outlined when asked.
    private async screenshot(request: Message): Promise<Message> {
        const win = this.window();
        if (!win || win.isDestroyed()) throw new UsageError('no-window', 'the window is not open');
        const overlay = request.overlay === true;
        const area = await this.page({ op: 'area', overlay });
        try {
            const image = await win.webContents.capturePage({ x: area.x as number, y: area.y as number, width: area.width as number, height: area.height as number });
            return { ...area, png: image.toPNG().toString('base64') };
        } finally {
            if (overlay) await this.page({ op: 'area', overlay: false });
        }
    }
}
