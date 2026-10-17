// GUI tests: Robustness (hunting for crashes).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { WELCOME } from '../../src/welcome.js';
import { readTextFile } from '../../src/files.js';
import { highlight } from '../../src/editor/highlighter.js';
import { HighlightCache } from '../../src/markdown/highlight.js';
import { createTags, SYNTAX_TAGS } from '../../src/editor/tags.js';
import { LineTagger, normalize, tagRanges } from '../../src/editor/tagsync.js';
import { section, test, ok, eq, tmp, opt, DIM, RESET } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { countPointerEvents, screenPoint } from '../widgets.js';
import { MouseInput } from './mouse-input.js';

export function robustnessTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo, action, waitImages, samplePath } = c;

    section('Robustness (hunting for crashes)');
    test('the cursor sweeps every line of the sample document', () => {
        setText(WELCOME);
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
        for (let i = n - 1; i >= 0; i--) cursorTo(i);
    });
    test('typing on every line of the sample document', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); buf.insert_at_cursor('x', -1); pump(); }
    });
    test('deleting the whole document bit by bit', () => {
        setText(WELCOME);
        while (buf.get_char_count() > 0) {
            const e = buf.get_end_iter(), s = e.copy();
            s.backward_chars(7);
            buf.delete(s, e);
            pump();
        }
    });
    // Highlighting only reapplies the lines that changed (editor/tagsync.ts). After any
    // edit, the tags in the buffer must be exactly the same as highlighting the document from scratch.
    test('incremental highlighting is the same as highlighting from scratch', () => {
        // The mermaidhide tag and the image spacing depend on asynchronous rendering/loading, so they are not compared.
        const snapshot = () => {
            const out: Record<string, string> = {};
            buf.get_tag_table().foreach(tag => {
                const name = tag.name ?? '';
                if (name === 'mermaidhide' || name.startsWith('image-gap') || name.startsWith('mermaid-gap')) return;
                const r = tagRanges(buf, tag);
                if (r.length) out[name] = JSON.stringify(r);
            });
            return out;
        };
        const compare = (what: string) => {
            const cursor = buf.get_iter_at_mark(buf.get_insert()).get_offset();
            const incremental = snapshot();
            ed.setText(text());
            buf.place_cursor(buf.get_iter_at_offset(cursor));
            pump();
            const fresh = snapshot();
            for (const name of new Set([...Object.keys(incremental), ...Object.keys(fresh)]))
                eq(incremental[name], fresh[name], `tag ${name} setelah ${what}`);
        };

        // A simple random generator with a fixed seed, so failures can be repeated.
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const pieces = ['x', '\n', '**', '`', '```\n', '| a |', '# ', '- [ ] ', '> ', '🎉', '~~', '\n\n', '![g](a.png)'];
        setText(readTextFile(samplePath));
        for (let round = 0; round < 8; round++) {
            // Several edits before highlighting runs, so dirty ranges are merged.
            for (let k = 0; k < 1 + rand(4); k++) {
                const n = buf.get_char_count();
                const at = buf.get_iter_at_offset(rand(n + 1));
                if (rand(3) === 0 && n > 0) {
                    const end = at.copy();
                    end.forward_chars(1 + rand(30));
                    buf.delete(at, end);
                } else {
                    buf.insert(at, pieces[rand(pieces.length)], -1);
                }
            }
            buf.place_cursor(buf.get_iter_at_offset(rand(buf.get_char_count() + 1)));
            pump();
            if (round % 3 === 2) { buf.undo(); pump(); }
            compare(`edit number ${round + 1}`);
        }
    });
    // Markers are hidden incrementally (editor/decorations.ts): only the old/new active lines and
    // the re-parsed lines are checked. Compare against computing all markers.
    test('incrementally hidden markers are the same as the full computation', () => {
        const expected = () => {
            const ins = buf.get_iter_at_mark(buf.get_insert()).get_line();
            const sel = buf.get_iter_at_mark(buf.get_selection_bound()).get_line();
            const l0 = Math.min(ins, sel), l1 = Math.max(ins, sel);
            if (ed.modes.source) return [];
            const ranges = ed.markers.filter(([, , r0, r1]) => r1 < l0 || r0 > l1).map(([a, b]) => [a, b] as [number, number]);
            return normalize(ranges);
        };
        let seed = 11;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const pieces = ['x', '\n', '**b**', '`k`', '```\n', '# ', '> ', '🎉', '*m*', '\n\n', '![g](a.png)', '~~c~~'];
        const check = (what: string) => eq(JSON.stringify(tagRanges(buf, ed.tags.hidden)), JSON.stringify(expected()), what);
        // A new ``` fence changes the markers of the lines below it without editing those lines.
        setText('start\n\n**one** and *two*\n\n# Title\nend');
        cursorTo(0);
        check('before the fence');
        buf.insert(iterAtLine(buf, 1), '```\n', -1); pump();
        check('after the fence is opened');
        cursorTo(6);
        check('cursor moved after the fence');
        buf.undo(); pump();
        check('after the fence is undone');
        setText(readTextFile(samplePath));
        try {
            for (let round = 0; round < 60; round++) {
                const n = buf.get_char_count();
                const at = buf.get_iter_at_offset(rand(n + 1));
                if (rand(4) === 0 && n > 0) {
                    const end = at.copy();
                    end.forward_chars(1 + rand(40));
                    buf.delete(at, end);
                } else if (rand(5) > 0) {
                    buf.insert(at, pieces[rand(pieces.length)], -1);
                }
                const count = buf.get_char_count();
                if (rand(4) === 0) buf.select_range(buf.get_iter_at_offset(rand(count + 1)), buf.get_iter_at_offset(rand(count + 1)));
                else buf.place_cursor(buf.get_iter_at_offset(rand(count + 1)));
                if (rand(15) === 0) ed.setMode('source', !ed.modes.source);
                if (rand(10) === 0) buf.undo();
                pump();
                check(`hidden markers at step ${round + 1}`);
            }
        } finally {
            ed.setMode('source', false);
            pump();
        }
    });
    // Incremental highlighting (MarkdownView.queueFill): a long document is tagged partially first,
    // the rest is done in installments. The end result must be exactly the same as full highlighting.
    test('incremental highlighting of a long document is the same as full highlighting', () => {
        const long = Array.from({ length: 300 }, (_, i) =>
            `## Section ${i}\n\nParagraph **bold** and *italic* number ${i} 🎉 with \`code\`.\n\n`).join('');
        ed.setText(long);
        const lastLine = buf.get_line_count() - 3;
        const boldAt = (line: number) => {
            const it = iterAtLine(buf, line);
            it.forward_chars(12);
            return it.has_tag(ed.tags.bold);
        };
        ok(boldAt(2), 'the start of the document was tagged immediately');
        ok(!ed.highlightComplete && !boldAt(lastLine), 'the end of the document should still be pending');
        // Editing while the installments run, including adding lines.
        buf.insert(iterAtLine(buf, 6), '**new**\n\n', -1);
        for (let i = 0; i < 1000 && !ed.highlightComplete; i++) pump();
        ok(ed.highlightComplete, 'incremental highlighting did not finish');
        ok(boldAt(lastLine + 2), 'the end of the document was tagged after the installments');
        eq(w.outline.count, 300, 'number of outline rows');

        const reference = new Gtk.TextBuffer();
        const tags = createTags(reference);
        reference.set_text(text(), -1);
        highlight(reference, new HighlightCache(tags), new LineTagger(reference, SYNTAX_TAGS.map(n => tags[n])));
        for (const name of SYNTAX_TAGS)
            eq(JSON.stringify(tagRanges(buf, ed.tags[name])), JSON.stringify(tagRanges(reference, tags[name])), `tag ${name}`);
        const line = buf.get_iter_at_mark(buf.get_insert()).get_line();
        const hidden = normalize(ed.markers.filter(([, , r0, r1]) => r1 < line || r0 > line).map(([a, b]) => [a, b] as [number, number]));
        eq(JSON.stringify(tagRanges(buf, ed.tags.hidden)), JSON.stringify(hidden), 'hidden markers');
        setText('');
    });
    test('incremental highlighting prioritizes the lines around the cursor', () => {
        const long = Array.from({ length: 3000 }, (_, i) => `Paragraph **bold** number ${i}.\n\n`).join('');
        ed.setText(long);
        const lastLine = buf.get_line_count() - 3;
        buf.place_cursor(iterAtLine(buf, lastLine));
        ed.view.scroll_to_mark(buf.get_insert(), 0, false, 0, 0);
        const boldAt = (line: number) => {
            const it = iterAtLine(buf, line);
            it.forward_chars(12);
            return it.has_tag(ed.tags.bold);
        };
        const ctx = GLib.MainContext.default();
        for (let i = 0; i < 2000 && !boldAt(lastLine) && !ed.highlightComplete; i++) ctx.iteration(false);
        ok(boldAt(lastLine), 'the cursor line at the end of the document was not tagged');
        ok(!ed.highlightComplete && !boldAt(3000), 'the middle of the document should still be pending');
        for (let i = 0; i < 5000 && !ed.highlightComplete; i++) pump();
        ok(ed.highlightComplete && boldAt(3000), 'the installments did not finish');
        setText('');
    });
    test('the line cache equals a fresh parser after the block context and Unicode change', () => {
        const reference = new Gtk.TextBuffer();
        const tags = createTags(reference);
        const check = () => {
            reference.set_text(text(), -1);
            const fresh = highlight(reference, new HighlightCache(tags), new LineTagger(reference, SYNTAX_TAGS.map(n => tags[n])));
            eq(ed.markers, fresh.markers, 'marker cache');
            eq(ed.headings, fresh.headings, 'heading cache');
            eq(ed.tables, fresh.tables, 'table cache');
            eq(ed.starts, fresh.starts, 'Unicode offset cache');
            for (const name of SYNTAX_TAGS)
                eq(tagRanges(buf, ed.tags[name]), tagRanges(reference, tags[name]), `tag cache ${name}`);
        };
        setText('😀 start\n# Title\n**bold**\n\nA | B\n-- | --\none | two\n\n```js\nconst x = 1;\n```\nend');
        check();
        const insert = (line: number, value: string) => {
            buf.insert(iterAtLine(buf, line), value, -1); pump(); check();
        };
        insert(0, '🎉\n');
        insert(3, '```\n');  // inline/table formats turn into code block contents
        insert(7, '```\n');  // the table appears again after the closing fence
        insert(0, 'new paragraph\n');
        buf.undo(); pump(); check();
        buf.redo(); pump(); check();
        const end = iterAtLine(buf, 5);
        buf.delete(iterAtLine(buf, 0), end); pump(); check();
        setText('**bold**'); check();  // the last newline affects the tag ranges
        buf.insert_at_cursor('\n', -1); pump(); check();
    });
    test('setText finishes one highlight without a double callback', () => {
        let calls = 0;
        const original = ed.onHighlighted;
        ed.onHighlighted = result => { calls++; original(result); };
        try {
            setText('# New\n\nnote');
            eq(calls, 1, 'number of callbacks after setText');
            buf.insert_at_cursor('x', -1); pump();
            eq(calls, 2, 'the next edit is still highlighted');
        } finally { ed.onHighlighted = original; }
    });
    test('editing one heading keeps the other outline rows', () => {
        setText('# One\n\n## Two\n\n# Three');
        const first = w.outline.store.get_item(0)!;
        const last = w.outline.store.get_item(2)!;
        cursorTo(2, -1);
        buf.insert_at_cursor(' new', -1); pump();
        ok(w.outline.store.get_item(0) === first, 'the first heading was rebuilt');
        ok(w.outline.store.get_item(2) === last, 'the last heading was rebuilt');
        cursorTo(2);
        buf.insert_at_cursor('x', -1); pump();  // the second heading becomes a paragraph
        eq(w.outline.count, 2, 'one heading was removed');
        ok(w.outline.store.get_item(1) === last, 'the tail was not preserved');
        w.outline.list.emit('activate', 1); pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 4, 'click target after the heading was removed');
        buf.undo(); pump();
        eq(w.outline.count, 3, 'undo restored the heading');
    });
    test('the outline reuses labels when a heading only shifts lines', () => {
        setText('start\n\n# Title');
        const item = w.outline.store.get_item(0)!;
        buf.insert(buf.get_start_iter(), 'new line\n', -1); pump();
        ok(w.outline.store.get_item(0) === item, 'the outline item was not reused');
        w.outline.list.emit('activate', 0);
        pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 3, 'click target of the shifted heading');
    });
    test('focus mode and typewriter mode are active together', () => {
        setText(WELCOME);
        action('focus'); action('typewriter');
        for (let i = 0; i < buf.get_line_count(); i++) cursorTo(i);
        action('focus'); action('typewriter');
    });

    if (opt('mouse')) {
        section('Real mouse click (XTest)');
        const input = new MouseInput();
        const original = input.position();
        // Click at (x, y), in TextView widget coordinates.
        const xtest = (x: number, y: number) => {
            input.move(...screenPoint(ed.view, x, y, (xid, sx, sy) => input.toRoot(xid, sx, sy)));
            input.down();
            input.up();
            for (let k = 0; k < 8; k++) { pump(); GLib.usleep(15000); }
        };

        // Initial check: in some environments (tested here: XFCE/X11) the XTest pointer motion
        // arrives, but the mouse button is never received by GTK. The click tests below are
        // meaningless if the click does not arrive, so they are skipped with a note, not a false pass.
        setText('line one\n\nline two'); cursorTo(0);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        for (let k = 0; k < 20; k++) { pump(); GLib.usleep(15000); }
        const probe = countPointerEvents(ed.view);
        xtest(200, 140);
        probe.stop();
        const delivered = probe.presses;

        if (!delivered) {
            print(`  ${DIM}- skipped: XTest does not deliver mouse buttons to the window in this environment${RESET}`);
        } else {
            test('a double click on an image in the editor opens the viewer', () => {
                w.file = GLib.build_filenamev([tmp, 'dok.md']);
                setText('text\n\n![test](images/test.png)\n\nend'); waitImages(); cursorTo(0);
                for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
                let opened = false;
                const keep = ed.onViewImage;
                ed.onViewImage = () => { opened = true; };
                // A point 60 px below the top edge of the image (its height is 100): still inside the image even if the first click
                // shifts it down because the image syntax appears. Its position is taken from
                // the image widget, not from a formula, so it does not depend on the editor margin.
                const picture = ed.images.blocks[0].content.get_first_child()!;
                const [, px, py] = picture.translate_coordinates(ed.view, 40, 60);
                xtest(px, py);
                xtest(px, py);
                ed.onViewImage = keep;
                w.file = null;
                ok(opened, 'a double click with the mouse did not open the viewer');
            });
            test('clicking across the whole text area does not make the editor fail', () => {
                setText(WELCOME);
                for (let y = 20; y < ed.view.get_height(); y += 23)
                    for (const x of [20, 250, 600]) xtest(x, y);
            });
        }
        input.move(...original);
        input.close();
    }
}
