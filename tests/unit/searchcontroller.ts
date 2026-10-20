// Search and replace in all the notes without GTK: SearchController (app/search.ts) on a real temporary folder, with a
// view that records what it is sent. The panel only reports the query and what the user did. Runs on GJS and on Node.

import { AppSession } from '../../src/app/session.js';
import type { SearchQuery, SearchResults, SearchView } from '../../src/app/search.js';
import { section, test, eq, ok, tmp, disk, untilText } from '../framework.js';
import { fakeFrontend, FakeEditor, LaggingEditor, memorySettings, quiet } from './appsession.js';

const QUERY: SearchQuery = { text: '', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' };

export async function searchControllerTests(): Promise<void> {
    section('Search in the application session (no GTK)');
    let n = 0;
    const setup = (makeEditor: () => FakeEditor = () => new FakeEditor()) => {
        const dir = disk.join(tmp, `search-${++n}`);
        disk.mkdirs(disk.join(dir, 'sub'));
        disk.write(disk.join(dir, 'a.md'), '# Alpha\nfoo bar\n');
        disk.write(disk.join(dir, 'sub', 'b.md'), 'foo foo\n😀 foo\n');
        const shown: SearchResults[] = [];
        const view = quiet<SearchView>({ showResults: results => { shown.push(results); } });
        const questions: string[] = [];
        const answer = { yes: true };
        const session = new AppSession(fakeFrontend(memorySettings(), [], makeEditor, { searchView: view }));
        Object.assign(session.search.dialogs, { confirm: (message: string) => { questions.push(message); return answer.yes; } });
        session.start();
        session.files.setRoot(dir);
        return { dir, session, view, shown, questions, answer, last: () => shown.at(-1)! };
    };

    await test('a query from the panel is answered with plain results, a summary, and a mark for an invalid expression', () => {
        const { session, view, last, shown } = setup();
        view.onSearch({ ...QUERY, text: 'foo' });
        eq(last().files.map(f => [f.file, f.hits.length]), [['a.md', 1], ['sub/b.md', 3]]);
        eq(last().total, 4);
        ok(last().message.includes('4 results in 2 files'), last().message);
        eq(JSON.parse(JSON.stringify(last())), last(), 'not plain data');
        view.onSearch({ ...QUERY, text: 'foo', exclude: 'sub' });
        eq(last().files.map(f => f.file), ['a.md'], 'excluded folder');
        ok(last().message.includes('1 filter'), last().message);
        view.onSearch({ ...QUERY, text: 'FOO', caseSensitive: true });
        eq(last().total, 0, 'case');
        view.onSearch({ ...QUERY, text: '(', regex: true });
        ok(last().invalid && last().message !== '' && last().files.length === 0, 'an invalid expression');
        view.onSearch({ ...QUERY, text: '' });
        eq([last().message, last().files.length, last().invalid], ['', 0, false], 'an empty query');
        const count = shown.length;
        session.files.setRoot(null);
        view.onSearch({ ...QUERY, text: 'foo' });
        ok(shown.length === count + 1 && last().message.includes('Open a folder'), last().message);
        session.dispose();
    });

    await test('a hit opens its file with the match selected, counted in code points; a hit that was not shown is ignored', () => {
        const { dir, session, view } = setup();
        view.onSearch({ ...QUERY, text: 'foo' });
        view.onOpenHit('sub/b.md', 2);
        const doc = session.documents.active;
        eq(doc.file, disk.join(dir, 'sub', 'b.md'));
        eq((doc.editor as FakeEditor).selected, [1, 2, 3], 'line 1 after an emoji and a space');
        view.onOpenHit('a.md', 5);
        view.onOpenHit('../outside.md', 0);
        eq(session.documents.active.file, doc.file, 'nothing else opened');
        session.dispose();
    });

    await test('Replace All asks first, then writes closed files to disk and open ones through their editor, and searches again', async () => {
        const { dir, session, view, last, questions, answer } = setup();
        view.onSearch({ ...QUERY, text: 'foo' });
        session.host.openInTab(disk.join(dir, 'a.md'));
        answer.yes = false;
        await view.onReplaceAll('baz');
        eq(questions.length, 1, 'asked');
        eq(disk.read(disk.join(dir, 'sub', 'b.md')), 'foo foo\n😀 foo\n', 'declined: untouched');
        answer.yes = true;
        await view.onReplaceAll('baz');
        eq(disk.read(disk.join(dir, 'sub', 'b.md')), 'baz baz\n😀 baz\n');
        eq((session.documents.active.editor as FakeEditor).text, '# Alpha\nbaz bar\n', 'the open file changed in its editor');
        eq(last().total, 0, 'searched again');
        session.dispose();
    });

    await test('a regular expression replaces with its groups; a literal replacement keeps its $', async () => {
        const { dir, session, view } = setup();
        view.onSearch({ ...QUERY, text: '(foo) (bar)', regex: true });
        await view.onReplaceAll('$2 $1');
        eq(disk.read(disk.join(dir, 'a.md')), '# Alpha\nbar foo\n');
        view.onSearch({ ...QUERY, text: 'foo' });
        await view.onReplaceAll('$1');
        eq(disk.read(disk.join(dir, 'sub', 'b.md')), '$1 $1\n😀 $1\n');
        session.dispose();
    });

    await test('Replace All in an open document whose writes land a turn later does not read its own write', async () => {
        const { dir, session, view, last } = setup(() => new LaggingEditor());
        session.host.openInTab(disk.join(dir, 'a.md'));
        view.onSearch({ ...QUERY, text: 'foo' });
        await view.onReplaceAll('baz');
        eq(last().total, 0, 'the results already follow the replacement, before the editor has applied it');
        await untilText(session.documents.active.editor, '# Alpha\nbaz bar\n');
        session.dispose();
    });
}
