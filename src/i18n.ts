// Interface translations (gettext). The source language is English: text in code and .ui files
// is written in English and wrapped in _(), then po/*.po translates it.
//
// The domain is bound when this module is evaluated, before other modules that call _() at the top
// level (e.g. command palette labels), because ES modules are evaluated in order from the innermost
// import. .ui files (Gtk.Template) use the default domain set by textdomain() here.

import gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const GETTEXT_DOMAIN = 'markwork';

// Locale folder: installed = <prefix>/share/locale (bundle in <prefix>/share/markwork), from dist/ =
// <repo>/locale which usually does not exist, so the source text is shown as is.
function localeDir(): string {
    let dir = Gio.File.new_for_uri(import.meta.url).get_parent();
    if (dir && !dir.get_child('markwork.js').query_exists(null)) dir = dir.get_parent();   // from dist/chunks/
    return GLib.build_filenamev([dir?.get_parent()?.get_path() ?? '.', 'locale']);
}

gettext.bindtextdomain(GETTEXT_DOMAIN, localeDir());
gettext.textdomain(GETTEXT_DOMAIN);

export const _ = (text: string): string => gettext.dgettext(GETTEXT_DOMAIN, text);
export const ngettext = (one: string, many: string, n: number): string => gettext.dngettext(GETTEXT_DOMAIN, one, many, n);
// The same text with different meanings (e.g. "Open" button vs title) is distinguished with a context.
export const pgettext = (context: string, text: string): string => gettext.dpgettext(GETTEXT_DOMAIN, context, text);

// Fill {name} in translated text. Named placeholders (not template literals) so xgettext can
// extract the text and translators can reorder words.
export const fmt = (text: string, values: Record<string, string | number>): string =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
