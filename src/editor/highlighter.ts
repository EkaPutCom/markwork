// The GtkTextBuffer side of the syntax highlighting (markdown/highlight.ts): hands the parser the buffer's lines and
// applies the spans it returns as tags through LineTagger (tagsync.ts), so only changed lines are touched.

import type Gtk from 'gi://Gtk?version=4.0';
import type { HighlightCache, HighlightResult, TextLines } from '../markdown/highlight.js';
import type { LineTagger } from './tagsync.js';
import { iterAtLine } from '../gtkutil.js';

export type GtkHighlightCache = HighlightCache<Gtk.TextTag>;

// The buffer as the parser reads it. lines() reads only the edited lines, not the whole buffer.
function bufferLines(buffer: Gtk.TextBuffer): TextLines {
    return {
        get lineCount() { return buffer.get_line_count(); },
        all() {
            const [start, end] = buffer.get_bounds();
            return buffer.get_text(start, end, true);
        },
        lines(first, last) {
            const more = last + 1 < buffer.get_line_count();
            const raw = buffer.get_text(iterAtLine(buffer, first), more ? iterAtLine(buffer, last + 1) : buffer.get_end_iter(), true);
            return (more ? raw.slice(0, -1) : raw).split('\n');
        },
    };
}

// Parse the buffer (only around `edited` when the cache holds the last parse) and apply the tags.
export function highlight(buffer: Gtk.TextBuffer, cache: GtkHighlightCache, tagger: LineTagger, edited?: [number, number] | null): HighlightResult<Gtk.TextTag> {
    const result = cache.update(bufferLines(buffer), edited);
    tagger.apply(result.spans, result.starts);
    return result;
}
