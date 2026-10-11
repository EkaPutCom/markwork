#!/bin/sh
# Generate po/markwork.pot from the files in po/POTFILES.in (npm run pot).
#
# xgettext only knows TypeScript since gettext 0.23; older versions (e.g. 0.21 on Ubuntu 24.04)
# read .ts as JavaScript, which is enough because text is wrapped in _(), pgettext(), or ngettext().
# .ui files are read as Glade, the rest (desktop, metainfo, schema) through xgettext's built-in ITS rules.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
files=$(grep -v '^#' po/POTFILES.in | grep -v '^$')
common="--from-code=UTF-8 --add-comments=Translators: --package-name=markwork --msgid-bugs-address=https://markwork.ekaput.com/"
xgettext $common -L JavaScript --keyword=_ --keyword=pgettext:1c,2 --keyword=ngettext:1,2 -o "$tmp/ts.pot" $(echo "$files" | grep '\.ts$')
xgettext $common -L Glade -o "$tmp/ui.pot" $(echo "$files" | grep '\.ui$')
xgettext $common -o "$tmp/data.pot" $(echo "$files" | grep -E '\.(desktop\.in|metainfo\.xml\.in|gschema\.xml)$')
msgcat --use-first -o po/markwork.pot "$tmp"/*.pot
echo "po/markwork.pot: $(grep -c '^msgid ' po/markwork.pot) strings"
