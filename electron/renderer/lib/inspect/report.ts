// A report of a problem with the editor, from a person who writes (docs/design/debugger.md, section 11): the repro of
// what the editor just did, maybe blurred, maybe with a picture of the editor, saved as a file by the main process. It
// runs in every build; only the recorder feeds it, and no check runs until a developer or an agent replays it.

import { Transaction, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { blurText } from '../../../../src/markdown/blur.js';
import { focusOn, sourceOn, visualOn } from '../editor.js';
import { recordingOf, unrecorded } from './recorder.js';
import { blurRepro, reproOf, type Repro } from './repro.js';

export const modeOf = (state: EditorState): 'visual' | 'live' | 'source' => sourceOn(state) ? 'source' : visualOn(state) ? 'visual' : 'live';

// The repro of an editor's recording so far, with the checks that failed in it (none outside dev mode). `steps: false`
// leaves the recording out: the text as it is now is the start, and nothing is played.
export function reproOfEditor(view: EditorView, options: { note?: string; steps?: boolean } = {}): Repro | null {
    const recording = recordingOf(view.state);
    if (!recording) return null;
    const failed = [...new Set(recording.entries.flatMap(e => (e.findings ?? []).filter(f => f.severity === 'fail').map(f => f.check)))];
    const repro = reproOf(recording, {
        app: { version: __APP_VERSION__, os: navigator.platform },
        editor: { mode: modeOf(view.state), focus: focusOn(view.state), width: Math.round(view.contentDOM.getBoundingClientRect().width) },
        doc: view.state.doc.toString(), failed, note: options.note,
    });
    if (options.steps === false) {
        const { main } = view.state.selection;
        return { ...repro, start: { doc: repro.actual!.doc, selection: [[main.anchor, main.head]] }, steps: [] };
    }
    return repro;
}

// A person's report: no `expect`, since nothing was checked (outside dev mode no check runs); what they expected is
// in their note. Blurred unless they said otherwise.
export function reportOf(view: EditorView, options: { note?: string; steps: boolean; blur: boolean }): Repro | null {
    const repro = reproOfEditor(view, options);
    if (!repro) return null;
    const { expect: _expect, ...report } = repro;
    return options.blur ? blurRepro(report) : report;
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

// The state of a view with its text blurred: as long as the real one, so the selection and everything drawn over it
// lands where it did. Never dispatched, so the tab's text, history, and recording never see it.
function blurredState(state: EditorState): EditorState {
    return state.update({
        changes: { from: 0, to: state.doc.length, insert: blurText(state.doc.toString()) },
        selection: state.selection, annotations: Transaction.addToHistory.of(false),
    }).state;
}

// A picture of the editor's part of the window, taken while the editor shows its text blurred (when asked) for a frame
// or two; the state it had is put back after, the same state, so nothing of the tab has changed.
export async function takeEditorPicture(view: EditorView, blur: boolean): Promise<void> {
    const original = view.state, snapshot = view.scrollSnapshot();
    // A new state is drawn from the top: the editor is put back where the person was looking (both states have the
    // same positions, so one snapshot serves both), by a transaction the recording leaves out.
    const keepScroll = () => view.dispatch({ effects: snapshot, annotations: unrecorded.of(true) });
    if (blur) { view.setState(blurredState(original)); keepScroll(); }
    try {
        await frame();
        await frame();
        // capturePage measures in the page's own pixels (CSS px), whatever the screen's scale.
        const r = view.dom.getBoundingClientRect();
        await window.markwork.takeReportPicture({ x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.round(r.width), height: Math.round(r.height) });
    } finally {
        if (blur) { view.setState(original); keepScroll(); }
    }
}
