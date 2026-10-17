// Colors the contents of code blocks according to their language (```js, ```python, ...).
//
// The coloring is done by GtkSourceView itself, which already has definitions for
// hundreds of languages and several color schemes:
//
//   1. The block contents are copied into a hidden GtkSource.Buffer (one per language) whose
//      language is already set, then ensure_highlight() highlights it right away.
//   2. The highlight tags are read range by range, then their style (color, bold,
//      italic, ...) is condensed into "segments".
//   3. Each distinct style gets one "syntax:..." tag in the editor buffer,
//      and the segments are applied with that tag.
//
// Segments are stored in a cache per (scheme, language, block contents). Typing outside a code
// block, or in another block, does not make this block get highlighted again.

import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import type { CodeBlock } from '../markdown/highlight.js';
import { setTagGroup, type Range } from './tagsync.js';

const CACHE_LIMIT = 300;  // number of blocks kept; the cache is cleared if exceeded

// Language names commonly written after ``` → GtkSourceView language id.
// Other names are tried directly as an id, then as a file extension (rs, kt, ...).
const ALIASES: Record<string, string> = {
    javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
    ts: 'typescript', tsx: 'typescript-jsx',
    py: 'python3', python: 'python3', py3: 'python3',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh',
    'c++': 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c',
    'c#': 'c-sharp', cs: 'c-sharp', csharp: 'c-sharp',
    golang: 'go', rs: 'rust', rb: 'ruby', kt: 'kotlin',
    yml: 'yaml', md: 'markdown', svg: 'xml', jsonc: 'json', json5: 'json',
    htm: 'html', vue: 'html', patch: 'diff', make: 'makefile',
};

export function resolveLanguage(name: string): GtkSource.Language | null {
    if (!name) return null;
    const manager = GtkSource.LanguageManager.get_default();
    const id = name.toLowerCase();
    return manager.get_language(ALIASES[id] ?? id) ?? manager.guess_language(`file.${id}`, null);
}

// Styled range inside one block: [start, end, style key] (code point offsets).
type Segment = [start: number, end: number, style: string];

// Styles copied from GtkSourceView tags. The background is deliberately not copied,
// so code blocks keep using the background from the app theme.
interface Style {
    foreground?: string;
    weight?: Pango.Weight;
    style?: Pango.Style;
    underline?: Pango.Underline;
    strikethrough?: boolean;
}

function styleOf(tags: Gtk.TextTag[]): Style {
    const style: Style = {};
    // A tag with higher priority overrides one with lower priority.
    for (const tag of [...tags].sort((a, b) => a.get_priority() - b.get_priority())) {
        if (tag.foreground_set && tag.foreground_rgba) style.foreground = tag.foreground_rgba.to_string() ?? undefined;
        if (tag.weight_set) style.weight = tag.weight;
        if (tag.style_set) style.style = tag.style;
        if (tag.underline_set) style.underline = tag.underline;
        if (tag.strikethrough_set) style.strikethrough = tag.strikethrough;
    }
    return style;
}

const UNDERLINES = ['none', 'single', 'double', 'low', 'error'];

function spanAttributes(style: Style): string {
    let attrs = '';
    if (style.foreground) {
        const color = new Gdk.RGBA();
        if (color.parse(style.foreground)) {
            const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
            attrs += ` foreground="#${hex(color.red)}${hex(color.green)}${hex(color.blue)}"`;
        }
    }
    if (style.weight !== undefined) attrs += ` weight="${style.weight}"`;
    if (style.style === Pango.Style.ITALIC) attrs += ' style="italic"';
    else if (style.style === Pango.Style.OBLIQUE) attrs += ' style="oblique"';
    if (style.underline) attrs += ` underline="${UNDERLINES[style.underline] ?? 'single'}"`;
    if (style.strikethrough) attrs += ' strikethrough="true"';
    return attrs;
}

export class CodeHighlighter {
    // Called every time a new style tag is created, so the caller can raise
    // the priority of tags that must stay on top (e.g. 'dim' and 'hidden').
    onTagAdded: () => void = () => {};

    private applied: CodeBlock[] | null = null;
    private scheme: GtkSource.StyleScheme | null = null;
    private scratch = new Map<string, GtkSource.Buffer>();   // language id → hidden buffer
    private cache = new Map<string, Segment[]>();
    private styleTags = new Map<string, Gtk.TextTag>();      // style key → tag

    constructor(private readonly buffer: Gtk.TextBuffer) {}

    // Change the color scheme (called when the light/dark theme changes).
    setScheme(id: string): void {
        const scheme = GtkSource.StyleSchemeManager.get_default().get_scheme(id);
        if (scheme === this.scheme) return;
        this.scheme = scheme;
        for (const scratch of this.scratch.values()) scratch.set_style_scheme(scheme);
        this.applied = null;
        this.cache.clear();
        // Old tags use the old scheme's colors; remove them from the buffer.
        const table = this.buffer.get_tag_table();
        for (const tag of this.styleTags.values()) table.remove(tag);
        this.styleTags.clear();
    }

    // Color all code blocks. Called after highlighter.ts finishes.
    apply(blocks: CodeBlock[], force = true): void {
        // GTK keeps tags when text outside the block changes. Avoid reading
        // all tag ranges again if the block contents are the same, even if the offset shifts.
        if (!force && this.applied && blocks.length === this.applied.length && blocks.every((b, i) => {
            const old = this.applied![i];
            return b.lang === old.lang && b.text === old.text;
        })) return;
        this.applied = blocks;

        const wanted = new Map<Gtk.TextTag, Range[]>();
        for (const block of blocks) {
            const language = resolveLanguage(block.lang);
            if (!language || !block.text) continue;
            for (const [a, b, key] of this.segments(language, block.text)) {
                const tag = this.styleTag(key);
                if (!wanted.has(tag)) wanted.set(tag, []);
                wanted.get(tag)!.push([block.start + a, block.start + b]);
            }
        }
        setTagGroup(this.buffer, this.styleTags.values(), wanted);
    }

    // Block contents as colored Pango markup, for code blocks rendered as a widget
    // (codelayer.ts). Uses the same segments and cache as apply().
    markup(lang: string, code: string): string {
        const chars = Array.from(code);
        const text = (a: number, b: number) => GLib.markup_escape_text(chars.slice(a, b).join(''), -1);
        const language = resolveLanguage(lang);
        let out = '', pos = 0;
        for (const [a, b, key] of language ? this.segments(language, code) : []) {
            if (a < pos) continue;
            out += text(pos, a);
            out += `<span${spanAttributes(JSON.parse(key) as Style)}>${text(a, b)}</span>`;
            pos = b;
        }
        return out + text(pos, chars.length);
    }

    private segments(language: GtkSource.Language, code: string): Segment[] {
        const cacheKey = `${this.scheme?.get_id()}\0${language.get_id()}\0${code}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const scratch = this.scratchBuffer(language);
        scratch.set_text(code, -1);
        const [start, end] = scratch.get_bounds();
        scratch.ensure_highlight(start, end);

        const segments: Segment[] = [];
        const iter = scratch.get_start_iter();
        while (!iter.is_end()) {
            const from = iter.get_offset();
            const tags = iter.get_tags();
            iter.forward_to_tag_toggle(null);
            if (!tags.length) continue;
            const key = JSON.stringify(styleOf(tags));
            if (key === '{}') continue;
            const last = segments[segments.length - 1];
            if (last && last[1] === from && last[2] === key) last[1] = iter.get_offset();  // merge adjacent ones
            else segments.push([from, iter.get_offset(), key]);
        }

        if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
        this.cache.set(cacheKey, segments);
        return segments;
    }

    private scratchBuffer(language: GtkSource.Language): GtkSource.Buffer {
        let scratch = this.scratch.get(language.get_id());
        if (!scratch) {
            scratch = new GtkSource.Buffer({ language, highlight_syntax: true });
            scratch.set_style_scheme(this.scheme);
            this.scratch.set(language.get_id(), scratch);
        }
        return scratch;
    }

    private styleTag(key: string): Gtk.TextTag {
        let tag = this.styleTags.get(key);
        if (!tag) {
            const style = JSON.parse(key) as Style;
            tag = new Gtk.TextTag({ name: `syntax:${key}` });
            if (style.foreground) tag.foreground = style.foreground;
            if (style.weight !== undefined) tag.weight = style.weight;
            if (style.style !== undefined) tag.style = style.style;
            if (style.underline !== undefined) tag.underline = style.underline;
            if (style.strikethrough !== undefined) tag.strikethrough = style.strikethrough;
            this.buffer.get_tag_table().add(tag);
            this.styleTags.set(key, tag);
            this.onTagAdded();
        }
        return tag;
    }
}
