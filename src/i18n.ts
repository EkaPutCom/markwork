// Interface translations. The source language is English: text in code is written in English and wrapped in _(), then
// po/*.po translates it. The translating itself is the platform's (the gettext catalogs read by platform/node/i18n.ts);
// without a platform the source text is shown.

import { installedPlatform } from './platform/index.js';

const translations = () => installedPlatform()?.translations;

export const _ = (text: string): string => translations()?.text(text) ?? text;
export const ngettext = (one: string, many: string, n: number): string => translations()?.plural(one, many, n) ?? (n === 1 ? one : many);
// The same text with different meanings (e.g. "Open" button vs title) is distinguished with a context.
export const pgettext = (context: string, text: string): string => translations()?.context(context, text) ?? text;

// Fill {name} in translated text. Named placeholders (not template literals) so xgettext can
// extract the text and translators can reorder words.
export const fmt = (text: string, values: Record<string, string | number>): string =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
