// The panes of the editor area (electron/renderer/lib/panes.ts): splitting, moving a tab, closing, and the focus. The
// window draws what these functions return, so what a drag or a menu does to the panes is tested here without a window.

import * as P from '../../electron/renderer/lib/panes.js';
import { section, test, eq, ok } from '../core/framework.js';

// The panes as text: columns split by " | ", the panes of a column by " / ", each with its tabs and the one shown in brackets.
const show = (layout: P.Layout): string => layout.columns.map(c => c.panes.map(p => p.tabs.map(t => t === p.active ? `[${t}]` : String(t)).join(',') || '-').join(' / ')).join(' | ');
const opened = (...docs: number[]): P.Layout => docs.reduce((l, d) => P.open(l, d), P.initialLayout());

export function paneTests(): void {
    section('Panes (renderer/lib/panes.ts)');

    test('open and show: a new document is a tab of the focused pane; the core switching to one finds its pane', () => {
        const layout = opened(1, 2, 3);
        eq(show(layout), '1,2,[3]');
        eq(show(P.show(layout, 1)), '[1],2,3', 'the focused pane has it');
        const two = P.split(P.select(layout, 1, 1), 1, 'right');
        eq(show(two), '[1],2,3 | [1]', 'splitting shows the same document in a new pane');
        eq([two.current, P.activeDoc(two)], [2, 1], 'and the new pane has the focus');
        const back = P.show(two, 3);
        eq([show(back), back.current], ['1,2,[3] | [1]', 1], 'a document that only the first pane has: that pane takes the focus');
        eq(show(P.show(two, 9)), '[1],2,3 | 1,[9]', 'one that no pane has is a new tab of the focused pane');
    });

    test('split: right and left make columns, up and down make rows, and an empty pane cannot be split', () => {
        const base = opened(1, 2);
        eq(show(P.split(base, 1, 'right')), '1,[2] | [2]');
        eq(show(P.split(base, 1, 'left')), '[2] | 1,[2]');
        eq(show(P.split(base, 1, 'bottom')), '1,[2] / [2]');
        eq(show(P.split(base, 1, 'top')), '[2] / 1,[2]');
        eq(show(P.split(P.initialLayout(), 1, 'right')), '-', 'nothing to show in the new pane');
        const grid = P.split(P.split(base, 1, 'right'), 2, 'bottom');
        eq(show(grid), '1,[2] | [2] / [2]');
        eq(P.panesOf(grid).map(p => p.id), [1, 2, 3], 'ids are never reused');
    });

    test('closing a document removes its tab everywhere, shows the next one, and drops a pane left empty', () => {
        const grid = P.split(opened(1, 2, 3), 1, 'right');          // 1,2,[3] | [3]
        eq(show(P.close(grid, 3)), '1,[2]', 'the second pane had only that tab and is gone');
        eq(show(P.close(P.select(grid, 1, 2), 2)), '1,[3] | [3]', 'the neighbor takes its place');
        eq(show(P.close(P.close(P.close(grid, 1), 2), 3)), '-', 'the last tab leaves one empty pane');
    });

    test('closeTab: closes the document only when no other pane shows it', () => {
        const grid = P.split(opened(1, 2), 1, 'right');             // 1,[2] | [2]
        const once = P.closeTab(grid, 2, 2);
        eq([once.closesDocument, show(once.layout)], [false, '1,[2]'], 'the other pane still has it');
        const only = P.closeTab(grid, 1, 1);
        ok(only.closesDocument && show(only.layout) === show(grid), 'the layout waits for the core to close it');
    });

    test('drop: the middle joins the tabs, an edge makes a pane, and a pane left empty goes', () => {
        const grid = P.split(opened(1, 2, 3), 1, 'right');          // 1,2,[3] | [3]
        eq(show(P.drop(grid, 1, 1, 2, 'center')), '2,[3] | 3,[1]', 'to the middle of another pane');
        eq(show(P.drop(grid, 1, 3, 2, 'center')), '1,[2] | [3]', 'a tab the target has is not added twice');
        eq(show(P.drop(grid, 1, 2, 2, 'bottom')), '1,[3] | [3] / [2]', 'to the bottom edge of another pane');
        eq(show(P.drop(grid, 2, 3, 2, 'left')), '1,2,[3] | [3]', 'the only tab of a pane onto its own edge: nothing');
        eq(show(P.drop(grid, 1, 1, 1, 'right')), '2,[3] | [1] | [3]', 'a tab to the edge of its own pane');
        eq(show(P.drop(P.initialLayout(), null, 7, 1, 'center')), '[7]', 'a file that was not open');
        eq(show(P.drop(opened(1), null, 7, 1, 'right')), '[1] | [7]', 'a file of the sidebar onto an edge');
        eq(P.drop(grid, 1, 1, 2, 'center').current, 2, 'the pane that got it has the focus');
    });

    test('closePane joins its tabs to the pane before it, joinAll puts everything in the focused pane, moveToNextPane moves a tab', () => {
        const three = P.split(P.split(opened(1, 2), 1, 'right'), 2, 'right');    // 1,[2] | [2] | [2]
        eq(show(P.closePane(three, 2)), '1,[2] | [2]');
        eq(show(P.closePane(P.closePane(three, 3), 2)), '1,[2]');
        eq(show(P.closePane(opened(1), 1)), '[1]', 'the last pane stays');
        eq(show(P.joinAll(three)), '[2],1', 'the focused pane (the last one made) keeps its order and takes the others');
        const two = P.select(P.split(opened(1, 2), 1, 'right'), 1, 1);           // [1],2 | [2]
        eq(show(P.moveToNextPane(two)), '[2] | 2,[1]', 'the tab goes and is the one shown there; the pane it left shows another');
    });

    test('neighbor and reorder: the next tab round the bar, and a tab dragged within it', () => {
        const pane = P.currentPane(opened(1, 2, 3));
        eq([P.neighbor(pane, 1), P.neighbor(pane, -1)], [1, 2], 'round the ends');
        eq(P.neighbor(P.initialLayout().columns[0].panes[0], 1), 0);
        eq(P.currentPane(P.reorder(opened(1, 2, 3), 1, 3, 1)).tabs, [3, 1, 2], 'before a tab');
        eq(P.currentPane(P.reorder(opened(1, 2, 3), 1, 1, null)).tabs, [2, 3, 1], 'to the end');
    });

    test('source is per pane, and a split pane starts like the one it came from', () => {
        const layout = P.setSource(opened(1, 2), 1, true);
        eq(P.currentPane(P.split(layout, 1, 'right')).source, true);
        eq(P.paneById(P.setSource(P.split(layout, 1, 'right'), 2, false), 1)?.source, true, 'the other pane is as it was');
    });

    test('sizes: a line moves the share of the two panes it separates, and none goes below a quarter of an equal share', () => {
        const sizes = P.shift([1, 1, 1], 0, 0.5);
        eq(sizes, [1.5, 0.5, 1]);
        eq(P.shift([1, 1], 0, -5), [0.25, 1.75], 'a drag far past the edge stops at the minimum');
        eq(P.shift([1, 1], 0, 5).reduce((a, b) => a + b, 0), 2, 'the total does not change');
        const layout = P.resizeColumns(P.split(opened(1), 1, 'right'), 0, 0.5);
        eq(layout.columns.map(c => c.size), [1.5, 0.5]);
        const rows = P.resizePanes(P.split(opened(1), 1, 'bottom'), 0, 0, -0.5);
        eq(rows.columns[0].panes.map(p => p.size), [0.5, 1.5]);
    });
}
