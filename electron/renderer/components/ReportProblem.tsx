// "Something looks wrong?": a report of a problem with the editor, for the people the visual editor is for, in every
// build (docs/design/debugger.md, section 11; board 3 of docs/design/shadcn/Debugger.html). It saves what the editor
// just did as a repro file, the text blurred unless the person says otherwise, with a picture of the editor if they
// like; the main process writes it in the app's data folder, and nothing is sent anywhere. Help → Report a Problem with
// the Editor opens it, and so does the link that shows for a moment after an Undo of something just typed.

import { useEffect, useMemo, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { blurText } from '../../../src/markdown/blur.js';
import { observeRecordings, recordingOf, type Recording } from '../lib/inspect/recorder.js';
import { reportOf, takeEditorPicture } from '../lib/inspect/report.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Modal } from './Modals.js';

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

// The line of the cursor, as it would be saved: what the person sees of their own text before saving it.
function cursorLine(view: EditorView, blur: boolean): string {
    const { state } = view, line = state.doc.lineAt(state.selection.main.head);
    const text = blur ? blurText(state.doc.toString()).slice(line.from, line.to) : line.text;
    return text.trim() ? text : '(an empty line)';
}

function ReportForm({ view, onClose }: { view: EditorView; onClose: () => void }) {
    const [note, setNote] = useState('');
    const [steps, setSteps] = useState(true);
    const [blur, setBlur] = useState(true);
    const [picture, setPicture] = useState(true);
    const [busy, setBusy] = useState(false);
    // While the picture is taken the dialog is out of the way, and the editor shows the text as it will be saved.
    const [hidden, setHidden] = useState(false);
    const [saved, setSaved] = useState<{ path: string; name: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const count = recordingOf(view.state)?.entries.length ?? 0;
    const preview = useMemo(() => ({ real: cursorLine(view, false), blurred: cursorLine(view, true) }), [view]);

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            // Made before the picture: what the editor did up to now, not the blurred text shown for the picture.
            const report = reportOf(view, { note: note.trim() || undefined, steps, blur });
            if (!report) throw new Error('This editor keeps no recording.');
            if (picture) {
                setHidden(true);
                await frame();
                await frame();
                await takeEditorPicture(view, blur);
            }
            setSaved(await window.markwork.saveReport(JSON.stringify(report), picture));
        } catch (e) {
            setError(`The report could not be saved: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setHidden(false);
            setBusy(false);
        }
    };

    return (
        <div style={hidden ? { visibility: 'hidden' } : undefined}>
            <Modal title="Something looks wrong?" onClose={onClose} className="report">
                {saved ? (
                    <div className="form">
                        <p>The report is saved as <b>{saved.name}</b>. Nothing was sent: attach the file to a bug report, or give it to whoever fixes Markwork.</p>
                        <div className="buttons">
                            <button type="button" className="button suggested" autoFocus onClick={onClose}>Close</button>
                            <button type="button" className="button" onClick={() => void window.markwork.showReport(saved.path)}>Show File</button>
                        </div>
                    </div>
                ) : (
                    <form className="form" onSubmit={e => { e.preventDefault(); void save(); }}>
                        <p>Tell us what you expected. Markwork saves what the editor just did, so the problem can be played back and fixed.</p>
                        <label>What happened<textarea autoFocus rows={3} value={note} onChange={e => setNote(e.target.value)}
                            placeholder="I pressed Backspace after a bold word, and a star appeared instead of the last letter going away." /></label>
                        <div className="report-options" role="group" aria-label="What the report holds">
                            <label className="radio">
                                <input type="checkbox" checked={steps} onChange={e => setSteps(e.target.checked)} />
                                <span>What the editor just did<small>{count ? `The last ${count === 1 ? 'change' : `${count} changes`}` : 'Nothing yet'}: keys, clicks, and what each did. Nothing typed in other windows.</small></span>
                            </label>
                            <label className="radio">
                                <input type="checkbox" checked={blur} onChange={e => setBlur(e.target.checked)} />
                                <span>Blur my text<small>Letters become x and numbers 0, but Markdown, spaces, emoji, and other scripts stay, which is enough for a bug.</small>
                                    <code className="report-preview" aria-label="The line of the cursor, as it will be saved">{blur ? preview.blurred : preview.real}</code></span>
                            </label>
                            <label className="radio">
                                <input type="checkbox" checked={picture} onChange={e => setPicture(e.target.checked)} />
                                <span>A picture of the editor<small>{blur ? 'Blurred the same way.' : 'As it is on screen.'}</small></span>
                            </label>
                        </div>
                        {error && <div className="form-error" role="alert">{error}</div>}
                        <div className="buttons">
                            <button type="submit" className="button suggested" disabled={busy}>Save Report</button>
                            <button type="button" className="button" onClick={onClose}>Cancel</button>
                            <span className="report-foot">Saved as a file. Nothing is sent.</span>
                        </div>
                    </form>
                )}
            </Modal>
        </div>
    );
}

export function ReportDialog() {
    const client = useClient();
    const { info } = useStore();
    if (info !== 'report') return null;
    const close = () => client.showInfo(null);
    const view = client.currentEditor?.view;
    if (!view || !recordingOf(view.state)) {
        return <Modal title="Something looks wrong?" onClose={close}><div className="form"><p>Open a document first: a report is about the text editor.</p></div></Modal>;
    }
    return <ReportForm view={view} onClose={close} />;
}

const UNDO_AFTER_MS = 10_000;   // an Undo this soon after typing may be undoing what the editor did
const OFFER_MS = 5000;

// The undo of something typed within UNDO_AFTER_MS: the commonest sign that the editor did what was not expected.
function undidTyping(recording: Recording): boolean {
    const undo = recording.entries.at(-1);
    if (!undo || undo.userEvent !== 'undo') return false;
    return recording.entries.some(e => e !== undo && e.userEvent?.startsWith('input.type') && undo.t - e.t < UNDO_AFTER_MS);
}

// The link under the header that offers a report, for a few seconds after such an Undo; once a tab.
export function ReportOffer() {
    const client = useClient();
    const { info } = useStore();
    const [shown, setShown] = useState(false);
    useEffect(() => {
        const offered = new WeakSet<Recording>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = observeRecordings(recording => {
            if (offered.has(recording) || !undidTyping(recording)) return;
            offered.add(recording);
            setShown(true);
            clearTimeout(timer);
            timer = setTimeout(() => setShown(false), OFFER_MS);
        });
        return () => { stop(); clearTimeout(timer); };
    }, []);
    if (!shown || info === 'report') return null;
    return (
        <div className="report-offer">
            <button type="button" className="button flat" onClick={() => { setShown(false); client.run('report-problem'); }}>Something looks wrong?</button>
        </div>
    );
}
