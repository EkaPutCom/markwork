#!/bin/sh
# Generate po/markwork.pot from the files in po/POTFILES.in (npm run pot).
#
# xgettext only knows TypeScript since gettext 0.23; older versions (e.g. 0.21 on Ubuntu 24.04)
# read .ts as JavaScript, which is enough because text is wrapped in _(), pgettext(), or ngettext().
set -eu
cd "$(dirname "$0")/.."
files=$(grep -v '^#' po/POTFILES.in | grep -v '^$')
common="--from-code=UTF-8 --add-comments=Translators: --package-name=markwork --msgid-bugs-address=https://usemarkwork.com/"
xgettext $common -L JavaScript --keyword=_ --keyword=pgettext:1c,2 --keyword=ngettext:1,2 -o po/markwork.pot $files
echo "po/markwork.pot: $(grep -c '^msgid ' po/markwork.pot) strings"
