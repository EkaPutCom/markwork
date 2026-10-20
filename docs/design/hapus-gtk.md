# Rencana menghapus frontend GTK

20 Oktober 2026 · Eka Putra · lanjutan dari [`electron-migrasi.md`](electron-migrasi.md)

## Keputusan

- Electron menjadi satu-satunya frontend, juga di Linux. Frontend GTK (GTK 4, libadwaita, GJS) dihapus.
- **Tidak ada kompatibilitas mundur.** Setting di GSettings tidak dimigrasi ke `markwork-electron/settings.json`, dan tidak ada shim untuk pengguna GTK. Format data produk (berkas Markdown, frontmatter, `[key:: value]`) tidak termasuk keputusan ini.
- Sebelum menghapus, dua celah kualitas Electron sudah ditutup (PR 69): tata letak adaptif (`renderer/client.ts` `layoutOf`) dan padanan `tests/gui/sample.ts` dan `robust.ts` (`tests/electron-robust.mjs`).

**Pertanyaan terbuka:** pengganti Flatpak. Pilihannya Flathub dengan base app Electron (`org.electronjs.Electron2.BaseApp`), atau cukup AppImage dan deb dari electron-builder. Sampai diputuskan, `build-aux/flatpak/` dihapus bersama GTK dan Linux dirilis lewat AppImage dan deb.

## Yang terdampak

Ditentukan dengan graf impor dari entry point Electron (`electron/core.ts`, `main.ts`, `preload.ts`, `renderer/main.tsx`) dan dari tes core di Node (`tests/run-core-node.ts`).

- **90 modul `src/` hanya dipakai GTK:** `ui/` (51), `editor/` (20), `platform/gjs/` (8), `window.ts` dan `window/`, `app.ts`, `main.ts`, `actions.ts`, `gtkutil.ts`, `config.ts`, `colors.ts`, `env.d.ts`, `raw.d.ts`.
- **Hanya GTK dan tesnya:** `markdown/pango.ts`, `markdown/chatmarkup.ts`.
- **Dipakai bersama, tetap:** seluruh `app/`, `markdown/` (kecuali dua di atas), `agent/`, `forge/`, `platform/index.ts`, `platform/node/`, dan modul dasar di root `src/`.
- **Tetap walau dari era GTK:** `data/com.ekaput.Markwork.gschema.xml`, karena core Electron membaca skema setting darinya (`parseSchema`). `po/` dan `scripts/pot.sh` untuk terjemahan.
- **Build dan rilis GTK:** `vite.config.ts` (bundle GJS), `meson.build`, `po/meson.build`, `build-aux/flatpak/`, `data/*.desktop.in`, `data/*.metainfo.xml.in`, `data/markwork.in`, `scripts/capture.ts`, `@girs/*` di devDependencies.

## Tes

### Tes unit yang hanya jalan di GJS

| Berkas | Nasib | Status |
| --- | --- | --- |
| `discard.ts` | Ditulis ulang dengan `disk` dan `runGit`, masuk `core-tests.ts` | PR A |
| `settings.ts` | Tes `AppSettings` pindah ke `appsettings.ts` (core). Default dan simpan-baca tipe majemuk pindah ke `nodeplatform.ts` di atas `JsonSettingsStore`. Sisanya, GSettings, dihapus bersama GTK | PR A |
| `incremental.ts` | Tidak di-port: ketiga tesnya sudah punya padanan di `highlight.ts` (Node). Yang tersisa hanya sinkronisasi tag `GtkTextBuffer` | dihapus di PR B |
| `plaindata.ts` | Diperiksa juga oleh `tsconfig.node.json` | PR A |
| `actions.ts`, `gjsport.ts`, `codelang.ts` | Khusus GTK; pemilihan bahasa kode di Electron ada di `renderer/codecolor.ts` dan dites `electron-editor.mjs` | dihapus di PR B |
| `discardprompt.ts` | Pertanyaan discard dialog GTK (`ui/discard.ts`), dipisah dari `discard.ts` | dihapus di PR B |

### Tes GUI GTK (`tests/gui/`) dan padanannya

| Tes GTK | Padanan Electron |
| --- | --- |
| `format`, `syntax`, `wikilink`, `image`, `imagezoom`, `codeblock`, `codecolor`, `conflicts` | `electron-editor.mjs` |
| `lists`, `table`, `mermaid`, `file`, `folder`, `window` (sebagian) | `electron-smoke.mjs`, `electron-editor.mjs` |
| `tabs`, `home`, `htmlpage`, `dialogs`, `journal` | `electron-editor.mjs`, `electron-assistant.mjs` |
| `kanban`, `inbox`, `layouts`, `tablelayout`, `csv` | `electron-structured.mjs` |
| `chat`, `context` | `electron-assistant.mjs` |
| `history`, `collab` | `electron-git.mjs` |
| `harness`, `agentshost` | `electron-harness.mjs` |
| `sample`, `robust` | `electron-robust.mjs` |
| `gnome` (tata letak adaptif) | `electron-layout.mjs` |
| `gnome` (sisanya: header bar dan dialog libadwaita, aksen sistem) | khusus GNOME, tidak di-port |
| `kanban-mouse`, `folder-mouse`, `csv-mouse`, `mouse-input` (input X11 lewat XTest) | drag Playwright di tes masing-masing |
| `forgejo` (server Forgejo sungguhan) | belum ada; forge palsu di `electron-git.mjs` |

### Tes live dan benchmark

Semuanya jalan di GJS dan memakai GLib. Mereka menguji core (DeepSeek, forge, agent), jadi di PR B di-port ke Node dengan bundle sendiri seperti `run-core-node.ts`:

- `live.ts`, `live-commit.ts`, `live-agentic.ts`, `live-structured.ts`: DeepSeek sungguhan.
- `live-forge.ts`: Forgejo sungguhan.
- `bench-agentic.ts`.
- `bench.ts`: bagian `--no-gui` (Markdown) di-port; bagian yang mengukur editor GTK dihapus.

## Urutan

### PR A — tes core lepas dari GJS (tidak menghapus apa pun)

- [x] `discard.ts` di core, `discardprompt.ts` tinggal untuk GTK
- [x] `appsettings.ts` di core; default dan tipe majemuk di `nodeplatform.ts`
- [x] `plaindata.ts` diperiksa `tsconfig.node.json`
- [x] Tes core memakai `XDG_DATA_HOME` sendiri, jadi Trash dari tes tidak menyentuh milik pengguna
- [x] Dokumen ini

Lulus bila CI tiga OS hijau dan `gjs -m dist/run-tests.js` tidak gagal di tes selain dua tes undo CSV di GTK yang sudah gagal di `main`.

### PR B — hapus GTK

- Hapus `src/ui/`, `src/editor/`, `src/window.ts`, `src/window/`, `src/app.ts`, `src/main.ts`, `src/actions.ts`, `src/gtkutil.ts`, `src/platform/gjs/`, `src/env.d.ts`, `src/raw.d.ts`, `markdown/pango.ts`, dan `markdown/chatmarkup.ts` beserta tesnya. Cek dulu pemakai `config.ts` (`APP_ID`, `APP_NAME`) dan tipe `Palette` di `colors.ts`, lalu pindahkan yang masih dipakai.
- Hapus `tests/gui/`, `tests/run-tests.ts`, `tests/host-gjs.ts`, `tests/widgets.ts`, dan tes unit yang ditandai "dihapus di PR B". Port tes live dan benchmark core ke Node.
- `package.json`: jadikan skrip Electron sebagai `build`, `start`, dan `test`; buang skrip GJS dan `@girs/*`.
- Hapus `vite.config.ts`, `meson.build`, `po/meson.build`, `build-aux/flatpak/`, `data/*.desktop.in`, `data/*.metainfo.xml.in`, `data/markwork.in`, `scripts/capture.ts`.
- `tsconfig.json` tanpa global GJS. `scripts/layers.mjs` tanpa aturan `gi://` dan `ui/`, ditambah aturan bahwa `src/` tidak mengimpor `electron/`.
- Beri tag `v-gtk-final` di commit terakhir `main` sebelum PR ini di-merge.

Lulus bila typecheck, tes core di Node, dan tes Electron hijau di tiga OS.

### PR C — rapikan

- `platform/index.ts` tetap (fake platform di tes memakainya); buang komentar dan cabang khusus GJS.
- Jalan pintas di `app/` yang ada demi dua frontend, misalnya `Awaitable` yang bisa sinkron.
- Tulis ulang README, AGENT.md, dan `docs/ONBOARDING.md`; arsipkan `docs/audit-gtk4.md` dan `docs/learn-gtk.html`; tandai `electron.md` dan `electron-migrasi.md` selesai.

## Risiko

- Setelah PR B di-merge, GTK hanya ada di riwayat git (tag `v-gtk-final`).
- Fitur GNOME yang tidak punya padanan hilang: tampilan libadwaita, aksen sistem, `Adw.ShortcutsDialog`, Flatpak (lihat pertanyaan terbuka), metainfo untuk GNOME Software.
- Log run dan penampil commit tetap berupa dialog di jendela utama, bukan jendela terpisah seperti di GTK.
- Ukuran aplikasi naik dari skrip GJS kecil menjadi bundle Electron sekitar 100 MB.
