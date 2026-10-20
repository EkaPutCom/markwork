// Regex patterns for recognizing Markdown syntax.
// Used together by the highlighter (highlight.ts) and the HTML export (markdown/html.ts).

// Block-level patterns: tested against one whole line.
export const RE = {
    fence: /^(\s{0,3})(`{3,}|~{3,})(.*)$/,
    heading: /^(#{1,6})([ \t]+|$)/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^(?:[ \t]*>[ \t]?)+/,
    list: /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?/,
    tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
};

// Table separator row ("| --- | :-: |" or "--- | ---"). Must contain '|' so that it
// is not confused with the "---" divider line.
export const isTableSeparator = (line: string): boolean => line.includes('|') && RE.tableSep.test(line);

// Table start: a line containing '|' followed by a separator row.
export const startsTable = (lines: string[], i: number): boolean => lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]);

// Escape (\*) and inline code (`code`) in ONE regex, so they are recognized together
// from left to right as in CommonMark:
//   \`not code\`     the escape wins, because its backtick is already "eaten" by the escape
//   `C:\*`           the code wins, because the backslash is inside the code
// Groups: 1 = the escaped character, 2 = the opening backticks, 3 = the code contents.
export const ESCAPE_OR_CODE = (): RegExp => /\\([\\`*_{}[\]()#+\-.!~=|<>])|(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/g;

// Names of inline formats produced by parseInline().
export type InlineTag = 'code' | 'marker' | 'link' | 'image' | EmphasisTag;
export type EmphasisTag = 'bold' | 'italic' | 'bolditalic' | 'strike' | 'mark';

// Inline emphasis patterns: [tag name, regex, marker length].
// Order matters: *** is tried before **, and ** before *.
export const EMPHASIS: [EmphasisTag, RegExp, number][] = [
    ['bolditalic', /(\*\*\*)(?=\S)([\s\S]*?\S)\*\*\*/g, 3],
    ['bolditalic', /(?<!\w)(___)(?=\S)([\s\S]*?\S)___(?!\w)/g, 3],
    ['bold', /(\*\*)(?=\S)([\s\S]*?\S)\*\*/g, 2],
    ['bold', /(?<!\w)(__)(?=\S)([\s\S]*?\S)__(?!\w)/g, 2],
    ['italic', /(\*)(?=[^\s*])([\s\S]*?[^\s*])\*/g, 1],
    ['italic', /(?<!\w)(_)(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, 1],
    ['strike', /(~~)(?=\S)([\s\S]*?\S)~~/g, 2],
    ['mark', /(==)(?=\S)([\s\S]*?\S)==/g, 2],
];
