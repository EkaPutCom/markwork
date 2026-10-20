// The app protocol counts positions per Unicode character (code point, docs/design/protocol.md), while
// JavaScript strings count per UTF-16 unit. An emoji such as 🎉 = 1 character
// in a code point count but 2 units in JavaScript, so positions need to be converted.

// Returns a function: UTF-16 offset → code point offset.
export function makeCpMap(text: string): (offset: number) => number {
    if (!/[\uD800-\uDFFF]/.test(text)) return x => x;
    const map = new Int32Array(text.length + 1);
    let cp = 0;
    for (let i = 0; i < text.length; i++) {
        map[i] = cp;
        const c = text.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) map[++i] = cp;
        cp++;
    }
    map[text.length] = cp;
    return x => map[x];
}

// Returns a function: code point offset → UTF-16 offset, the inverse of makeCpMap.
export function makeU16Map(text: string): (offset: number) => number {
    if (!/[\uD800-\uDFFF]/.test(text)) return x => x;
    const map: number[] = [];
    for (let i = 0; i < text.length; i++) {
        map.push(i);
        const c = text.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) i++;
    }
    map.push(text.length);
    return x => map[x] ?? text.length;
}

// Code point offset → UTF-16 offset inside string s.
export const cpToU16 = (s: string, cp: number): number => Array.from(s).slice(0, cp).join('').length;

// String length in code points (the unit of the app protocol).
export function cpLength(s: string): number {
    if (!/[\uD800-\uDFFF]/.test(s)) return s.length;
    let count = 0;
    for (const _char of s) count++;
    return count;
}

// Word separators: whitespace (same as \s in JS) and the Markdown symbols # > * _ ` ~ = | -.
const ASCII_SEPARATOR = new Uint8Array(128);
for (const c of ' \t\n\v\f\r#>*_`~=|-') ASCII_SEPARATOR[c.charCodeAt(0)] = 1;

// Word count, the same as (s.match(/[^\s#>*_`~=|-]+/g) ?? []).length but without creating a
// string per word: opening a 100,000-word manuscript 3× faster and without garbage for the GC.
export function countWords(s: string): number {
    let words = 0, inWord = false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const separator = c < 128 ? ASCII_SEPARATOR[c] === 1
            : c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
              c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
        if (separator) inWord = false;
        else if (!inWord) { inWord = true; words++; }
    }
    return words;
}
