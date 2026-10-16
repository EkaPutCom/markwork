// Interface translations on GJS: gettext, bound to the app's domain when this module is evaluated. install.ts is the
// first import of every entry point, so the domain is bound before any module calls _() at the top level (command
// palette labels). .ui files (Gtk.Template) use the default domain set by textdomain() here.

import gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { Translations } from '../index.js';

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

export const gettextTranslations: Translations = {
    text: text => gettext.dgettext(GETTEXT_DOMAIN, text),
    plural: (one, many, n) => gettext.dngettext(GETTEXT_DOMAIN, one, many, n),
    context: (context, text) => gettext.dpgettext(GETTEXT_DOMAIN, context, text),
};
