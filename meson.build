# Installing Markwork on the system or as a Flatpak.
#
# The TypeScript code is bundled by Vite, not Meson: run `npm ci && npm run build` first,
# and then Meson installs the contents of dist/ along with the desktop file, metainfo, icons, schema, and translations.
#   npm ci && npm run build
#   meson setup _build --prefix=/usr
#   meson install -C _build

project('markwork',
  version: '1.0',
  license: 'MIT',
  meson_version: '>= 1.0.0',
)

app_id = 'com.ekaput.Markwork'
gnome = import('gnome')
i18n = import('i18n')

prefix = get_option('prefix')
datadir = get_option('datadir')
pkgdatadir = datadir / meson.project_name()

if not import('fs').exists('dist/markwork.js')
  error('dist/markwork.js does not exist: run `npm ci && npm run build` before meson setup')
endif

# The app bundle. The test/benchmark bundles and the schema compiled for dev are not installed;
# the schema is installed in the system schema directory (see below) and settings.ts looks for it there.
install_subdir('dist',
  install_dir: pkgdatadir,
  strip_directory: true,
  exclude_files: [
    'run-tests.js', 'capture.js', 'bench.js', 'bench-agentic.js', 'live-test.js',
    'gschemas.compiled', app_id + '.gschema.xml',
  ],
  exclude_directories: ['icons'],
)

gjs = find_program('gjs', dirs: ['/usr/bin'])
configure_file(
  input: 'data/markwork.in',
  output: 'markwork',
  configuration: {
    'GJS': gjs.full_path(),
    'PKGDATADIR': prefix / pkgdatadir,
  },
  install: true,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
)

i18n.merge_file(
  input: 'data' / app_id + '.desktop.in',
  output: app_id + '.desktop',
  type: 'desktop',
  po_dir: 'po',
  install: true,
  install_dir: datadir / 'applications',
)

i18n.merge_file(
  input: 'data' / app_id + '.metainfo.xml.in',
  output: app_id + '.metainfo.xml',
  po_dir: 'po',
  install: true,
  install_dir: datadir / 'metainfo',
)

install_data('data' / app_id + '.gschema.xml', install_dir: datadir / 'glib-2.0' / 'schemas')
install_subdir('data/icons/hicolor', install_dir: datadir / 'icons')

desktop_validate = find_program('desktop-file-validate', required: false)
if desktop_validate.found()
  test('desktop', desktop_validate, args: [meson.current_build_dir() / app_id + '.desktop'])
endif
appstream = find_program('appstreamcli', required: false)
if appstream.found()
  test('metainfo', appstream, args: ['validate', '--no-net', meson.current_build_dir() / app_id + '.metainfo.xml'])
endif
compile_schemas = find_program('glib-compile-schemas', required: false)
if compile_schemas.found()
  test('schema', compile_schemas, args: ['--strict', '--dry-run', meson.current_source_dir() / 'data'])
endif

subdir('po')

gnome.post_install(
  glib_compile_schemas: true,
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)
