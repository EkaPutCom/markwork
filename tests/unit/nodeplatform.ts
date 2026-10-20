// The parts of the Node runtime a core on Node needs besides the port's contract (tests/unit/platform.ts): its settings
// store, with the GSettings schema's keys and defaults, and its translations, from the same catalogs gettext reads.
// Node only: these modules use Node built-ins, so run-core-node.ts runs them after the core's tests.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppSettings } from '../../src/settings.js';
import { JsonSettingsStore, parseSchema, parseVariant } from '../../src/platform/node/settings.js';
import { catalogTranslations, languages, parseMo, pluralRule, userCatalog } from '../../src/platform/node/i18n.js';
import { SecretVault, answerSecret, remoteSecrets, type Cipher, type SecretRequest } from '../../src/platform/node/vault.js';
import { section, test, eq, ok, tmp, ROOT } from '../framework.js';

const schemaText = () => readFileSync(join(ROOT, 'data', 'com.ekaput.Markwork.gschema.xml'), 'utf8');

// A .mo catalog with `messages` (msgid → translations; "context\u0004id" for a context), as msgfmt writes one.
function moFile(header: string, messages: Record<string, string[]>): Uint8Array {
    const encoder = new TextEncoder();
    const entries = [['', [header]] as const, ...Object.entries(messages)].map(([id, strs]) => [encoder.encode(id), encoder.encode(strs.join('\0'))] as const);
    const n = entries.length, originals = 28, translations = originals + n * 8;
    let offset = translations + n * 8;
    const table = (index: 0 | 1) => entries.map(entry => { const at = offset; offset += entry[index].length + 1; return [entry[index].length, at]; });
    const ids = table(0), strs = table(1);
    const out = new Uint8Array(offset);
    const view = new DataView(out.buffer);
    [0x950412de, 0, n, originals, translations, 0, offset].forEach((v, i) => view.setUint32(i * 4, v, true));
    entries.forEach(([id, str], i) => {
        view.setUint32(originals + i * 8, ids[i][0], true); view.setUint32(originals + i * 8 + 4, ids[i][1], true);
        view.setUint32(translations + i * 8, strs[i][0], true); view.setUint32(translations + i * 8 + 4, strs[i][1], true);
        out.set(id, ids[i][1]);
        out.set(str, strs[i][1]);
    });
    return out;
}

export async function nodePlatformTests(): Promise<void> {
    section('The Node runtime: settings and translations');

    await test('the settings have the keys, types, and defaults of the GSettings schema', () => {
        const specs = parseSchema(schemaText());
        eq(Object.keys(specs).length, (schemaText().match(/<key /g) ?? []).length, 'every key');
        eq(specs['color-scheme'], { type: 's', default: 'system', choices: ['system', 'light', 'dark'] });
        eq([specs.autosave.default, specs.width.default, specs.tabs.default, specs.projects.default, specs['active-tab'].default], [true, 1100, [], {}, -1]);
        eq(parseVariant("[('a.md', 3), ('b', -1)]"), [['a.md', 3], ['b', -1]]);
        eq(parseVariant("{'shop': '/srv/shop'}"), { shop: '/srv/shop' });
    });

    await test('the settings are kept in a JSON file; a key or a value the schema does not take is refused', () => {
        const specs = parseSchema(schemaText());
        const file = join(tmp, 'node-settings', 'markwork', 'settings.json');
        const settings = new AppSettings(new JsonSettingsStore(file, specs));
        const changed: string[] = [];
        settings.onChanged(null, key => changed.push(key));
        eq([settings.autosave, settings.dark, settings.folder, settings.recentFiles], [true, null, null, []], 'the defaults');
        settings.dark = true;
        settings.folder = '/home/sari/notes';
        settings.recentFiles = [{ path: '/home/sari/notes/a.md', time: 1700000000 }];
        eq(changed, ['color-scheme', 'folder', 'recent-files']);
        const again = new AppSettings(new JsonSettingsStore(file, specs));
        eq([again.dark, again.folder, again.recentFiles], [true, '/home/sari/notes', [{ path: '/home/sari/notes/a.md', time: 1700000000 }]], 'read back');
        const store = again.store;
        let refused = 0;
        for (const [key, value] of [['nope', true], ['autosave', 'yes'], ['color-scheme', 'blue'], ['forge-poll-seconds', -5]] as const) {
            try { store.set(key, value); } catch { refused++; }
        }
        eq(refused, 4);
        writeFileSync(file, JSON.stringify({ autosave: 'not a boolean', width: 900 }));
        const edited = new AppSettings(new JsonSettingsStore(file, specs));
        eq([edited.autosave, edited.width], [true, 900], 'a value the key does not take reads as the default');
        eq(new AppSettings(new JsonSettingsStore(join(tmp, 'node-settings', 'none.json'), specs)).width, 1100, 'no file yet');
    });

    await test('every setting has its default, and compound values are written and read back', () => {
        const file = join(tmp, 'node-settings', 'defaults.json');
        const s = new AppSettings(new JsonSettingsStore(file, parseSchema(schemaText())));
        eq([s.focus, s.autosave, s.dark, s.folder, s.tabs, s.projects, s.sidebarPage, s.activeTab, s.home, s.recentFiles],
            [false, true, null, null, [], {}, 'files', -1, true, []], 'the defaults');
        eq([s.harnessMachine, s.machines, s.machineProjects, s.daemonCommand], ['', {}, {}, ''], 'where harnesses run: in this window, no machines');
        s.tabs = [{ file: '/tmp/a.md', cursor: 7 }, { file: '/tmp/b.md', cursor: 0 }];
        s.projects = { shop: '/tmp/shop' };
        s.sidebarPage = 'collab';
        Object.assign(s, { harnessMachine: 'vps', machines: { vps: 'eka@vps.example.com' }, machineProjects: { 'vps:shop': '/srv/shop' }, daemonCommand: '~/.local/bin/markworkd' });
        const again = new AppSettings(new JsonSettingsStore(file, parseSchema(schemaText())));
        eq(again.tabs, [{ file: '/tmp/a.md', cursor: 7 }, { file: '/tmp/b.md', cursor: 0 }], 'tabs');
        eq([again.projects, again.sidebarPage], [{ shop: '/tmp/shop' }, 'collab']);
        eq([again.harnessMachine, again.machines, again.machineProjects, again.daemonCommand], ['vps', { vps: 'eka@vps.example.com' }, { 'vps:shop': '/srv/shop' }, '~/.local/bin/markworkd'], 'machines');
        again.dark = false;
        again.dark = null;
        eq(again.dark, null, 'dark goes back to the system');
    });

    await test('translations come from the gettext catalog of the user\'s language, with its plural rule and contexts', () => {
        const mo = moFile('Content-Type: text/plain; charset=UTF-8\nPlural-Forms: nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\n', {
            Saved: ['Zapisano'],
            '{n} file': ['{n} plik', '{n} pliki', '{n} plików'],
            'menu\u0004Open': ['Otwórz'],
        });
        const t = catalogTranslations(parseMo(mo));
        eq([t.text('Saved'), t.text('Not in the catalog'), t.context('menu', 'Open'), t.context('other', 'Open')], ['Zapisano', 'Not in the catalog', 'Otwórz', 'Open']);
        eq([1, 3, 5, 22, 112].map(n => t.plural('{n} file', '{n} files', n)), ['{n} plik', '{n} pliki', '{n} plików', '{n} pliki', '{n} plików']);
        eq(catalogTranslations(null).plural('{n} file', '{n} files', 2), '{n} files', 'without a catalog, the source text');
        eq([0, 1, 7].map(pluralRule('nplurals=1; plural=0;')), [0, 0, 0]);
        eq([0, 1, 2].map(pluralRule('')), [1, 0, 1], 'English without a rule');
        const env = (values: Record<string, string>) => (name: string) => values[name];
        eq(languages(env({ LANG: 'id_ID.UTF-8' })), ['id_ID', 'id']);
        eq(languages(env({ LANGUAGE: 'pl:en', LANG: 'id_ID.UTF-8' })), ['pl', 'en']);
        eq(languages(env({ LC_ALL: 'C' })), []);
        const dir = join(tmp, 'node-locale');
        mkdirSync(join(dir, 'pl', 'LC_MESSAGES'), { recursive: true });
        writeFileSync(join(dir, 'pl', 'LC_MESSAGES', 'markwork.mo'), mo);
        ok(userCatalog(dir, env({ LANG: 'pl_PL.UTF-8' }))?.messages.has('Saved'), 'pl_PL falls back to pl');
        eq(userCatalog(dir, env({ LANG: 'de_DE.UTF-8' })), null);
    });
    section('The Node runtime: the secret vault');

    // A cipher that reverses the text, standing in for safeStorage.
    const cipher = (available = true): Cipher => ({
        available: () => available,
        encrypt: text => new TextEncoder().encode([...text].reverse().join('')),
        decrypt: data => [...new TextDecoder().decode(data)].reverse().join(''),
    });

    await test('the vault keeps items encrypted, by schema and attributes in any order', () => {
        const path = join(tmp, 'vault', 'secrets.json');
        const vault = new SecretVault(path, cipher());
        ok(vault.store('s', { a: '1', b: '2' }, 'sk-secret'), 'stored');
        eq(vault.lookup('s', { b: '2', a: '1' }), 'sk-secret');
        eq(vault.lookup('s', { a: '1' }), null, 'other attributes, other item');
        ok(!readFileSync(path, 'utf8').includes('sk-secret'), 'the file does not hold the text');
        eq(new SecretVault(path, cipher()).lookup('s', { a: '1', b: '2' }), 'sk-secret', 'a new vault reads it');
        vault.clear('s', { a: '1', b: '2' });
        eq(vault.lookup('s', { a: '1', b: '2' }), null);
    });

    await test('without encryption the vault stores nothing', () => {
        const vault = new SecretVault(join(tmp, 'vault-off', 'secrets.json'), cipher(false));
        eq(vault.store('s', {}, 'x'), false);
        eq(vault.lookup('s', {}), null);
    });

    await test('the core asks the vault over the channel, and a malformed request gets no answer', async () => {
        const vault = new SecretVault(join(tmp, 'vault-remote', 'secrets.json'), cipher());
        const sent: SecretRequest[] = [];
        const remote = remoteSecrets(request => {
            sent.push(request);
            const reply = answerSecret(vault, request);
            if (reply) queueMicrotask(() => remote.receive(reply));
        });
        eq(await remote.secrets.store('s', { k: 'v' }, 'label', 'token'), true);
        eq(await remote.secrets.lookup('s', { k: 'v' }), 'token');
        await remote.secrets.clear('s', { k: 'v' });
        eq(await remote.secrets.lookup('s', { k: 'v' }), null);
        eq(sent.length, 4);
        eq(answerSecret(vault, null), null);
        eq(answerSecret(vault, { id: 1, op: 'store', schema: 's', attributes: { k: 'v' } }), null, 'a store without a secret');
        eq(answerSecret(vault, { id: 1, op: 'lookup', schema: 's', attributes: { k: 3 } }), null, 'attributes are strings');
        eq(answerSecret(vault, { id: 1, op: 'delete', schema: 's', attributes: {} }), null, 'unknown operation');
    });

    await test('an unanswered request ends as no keyring', async () => {
        const remote = remoteSecrets(() => {}, 20);
        eq(await remote.secrets.lookup('s', {}), null);
        eq(await remote.secrets.store('s', {}, 'l', 'x'), false);
    });
}
