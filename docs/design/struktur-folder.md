# Rancangan struktur folder

21 Oktober 2026 · Eka Putra · lanjutan dari [`hapus-gtk.md`](hapus-gtk.md)

## Tujuan

Setelah GTK dihapus, Electron jadi satu-satunya frontend. Tapi struktur folder masih menyimpan bentuk lama: folder ala GNOME (`data/`, `shots/`), file lepas di root `src/`, dan `tests/` yang mencampur empat jenis tes. Rancangan ini merapikannya tanpa mengubah perilaku apa pun.

- **Tidak berubah:** aturan lapisan (`scripts/layers.mjs`) tetap sama, hanya cara menyebut path-nya yang berubah. URL publik situs (`docs/`, `docs/docs/*.html`) juga tetap.
- **Tidak ada kompatibilitas mundur** untuk path lama (lihat `hapus-gtk.md`), jadi tidak ada symlink atau re-export.
- Semua pemindahan memakai `git mv`, supaya `git log --follow` tetap jalan.

## Struktur sekarang

```
src/            17 file lepas di root + agent/ app/ forge/ markdown/ platform/
electron/       main, core, preload, updater + renderer/ (54 file datar, ui/, lib/)
markworkd/      daemon Go
tests/          unit/, samples/, dan di root: electron-*.mjs, live*.ts, bench*.ts, host*.ts, framework.ts, …
docs/           situs Pages + design/ + mockups/ + ONBOARDING.md
scripts/        build, layers, capture, forgejo, pot, make-icon
data/           gschema.xml + icons/hicolor (scalable + 2 symbolic)
build/          icon.png, entitlements.mac.plist (buildResources electron-builder)
po/             LINGUAS, POTFILES.in
bench/          AGENTIC.md, baseline.json
shots/          30 png
journal/        2 catatan harian
```

## Struktur tujuan

```
markwork/
├── src/                          core + application layer (tanpa file lepas di root kecuali globals.d.ts)
│   ├── base/                     ← settings, welcome, files, fileops, workspace, git, gitlog,
│   │                               credentials, cancel, i18n, activity (daftar BASE di layers.mjs)
│   │                               + settingskeys.ts (pengganti gschema.xml, lihat di bawah)
│   ├── orchestrator/             ← orchestrator.ts → index.ts, orchestratordaemon.ts → daemon.ts,
│   │                               daemonhub.ts → hub.ts
│   ├── markdown/  agent/  forge/  app/  platform/     (tetap)
│   └── globals.d.ts
├── electron/
│   ├── main.ts  core.ts  preload.ts  updater.ts  env.d.ts
│   └── renderer/
│       ├── index.html  main.tsx  App.tsx
│       ├── components/           ← komponen fitur *.tsx (Home, Board, Chat, Explorer, …)
│       ├── ui/                   komponen shadcn (tetap, alias "@/ui" di components.json)
│       ├── lib/                  ← logika non-komponen: client, useClient, keys, editor, findbar,
│       │                           codecolor, conflicts, diagrams, images, tables, chatmodel, utils
│       └── styles/               ← globals.css, theme.css
├── markworkd/                    (tetap)
├── tests/
│   ├── unit/                     (tetap)
│   ├── core/                     ← core-tests.ts, run-core-node.ts, framework.ts, fixtures.ts,
│   │                               host.ts, host-node.ts
│   ├── electron/                 ← electron-*.mjs tanpa awalan: smoke.mjs, editor.mjs, …, support.mjs
│   ├── live/                     ← live*.ts, forgejo-support.ts
│   ├── bench/                    ← bench.ts, bench-agentic.ts, baseline.json, AGENTIC.md (dari bench/)
│   └── samples/                  (tetap)
├── resources/                    ← gabungan data/ + build/: semua aset aplikasi
│   ├── icon.svg                  ← data/icons/hicolor/scalable/apps/com.ekaput.Markwork.svg
│   ├── icon.png                  ← build/icon.png (hasil make-icon)
│   ├── entitlements.mac.plist
├── po/                           (tetap: konvensi gettext, dibaca electron-build.mjs)
├── scripts/                      (tetap)
├── docs/                         situs GitHub Pages (URL tidak berubah)
│   ├── index.html  learn-*.html  docs/  assets/  CNAME  .nojekyll
│   ├── ONBOARDING.md
│   └── design/                   catatan desain
│       ├── *.md  electron/  shadcn/
│       └── mockups/              ← docs/mockups/
└── (root) README.md AGENT.md package.json electron-builder.yml components.json tsconfig*.json vite.node.config.ts
```

Yang dihapus:

- **`shots/`**: tidak dirujuk siapa pun. Ini screenshot `learn-gtk.html` yang sudah ikut terhapus bersama GTK.
- **`data/icons/hicolor/symbolic/`**: ikon simbolik GNOME. Tidak ada kode Electron yang memakainya.
- **`journal/`**: catatan harian yang terbuat oleh fitur Journal saat aplikasi dicoba di repo ini, lalu ikut ter-commit (`2026-10-20.md` masuk lewat abf6271). Dihapus dari git dan dimasukkan ke `.gitignore`, sedangkan berkasnya di disk tetap ada.
- **`data/com.ekaput.Markwork.gschema.xml`**: diganti modul TypeScript (lihat *Skema setting*).

## Alasan per bagian

- **`src/base/` dan `src/orchestrator/`.** Saat ini `layers.mjs` mengenali modul dasar lewat daftar 11 nama file, ditambah tiga nama lain untuk orkestrator. Kalau semuanya ada di folder, aturannya bisa ditulis dengan awalan path seperti aturan lain (`f.startsWith('base/')`), dan file baru otomatis masuk lapisan yang benar.
- **`renderer/components|lib|styles`.** Di renderer sekarang komponen dan logika murni bercampur dalam satu folder berisi 54 file. Pembagian ini mengikuti konvensi shadcn yang sudah dideklarasikan di `components.json` (`components`, `lib`, `hooks`). `ui/` tetap di tempatnya supaya `npx shadcn add` tidak perlu dikonfigurasi ulang. Hanya alias `components` yang berubah ke `@/components`.
- **`tests/` per jenis.** Ada empat runner yang berbeda (core di Node, Playwright Electron, live, bench), dan sekarang semuanya ada di satu root. Dengan folder per jenis, `tsconfig.json` cukup meng-exclude per folder (`tests/live`, `tests/bench`), bukan file per file.
- **`resources/`.** `data/` dan `build/` sama-sama berisi aset aplikasi, dan ikonnya bahkan terpecah di dua folder. electron-builder hanya perlu `directories.buildResources: resources`.
- **`docs/` tetap jadi akar Pages.** GitHub Pages hanya bisa menyajikan `/` atau `/docs` dari branch `main` tanpa workflow tambahan. Selain itu `docs/docs/` sudah punya URL publik di domain CNAME. Jadi cukup `mockups/` yang dipindah ke `design/`.

## Skema setting

`data/com.ekaput.Markwork.gschema.xml` adalah format **GSettings**, sistem setting GNOME yang dulu dibaca GTK. Electron tidak memakai GSettings. Setting disimpan di `settings.json` oleh `JsonSettingsStore` (`src/platform/node/settings.ts`), dan XML ini cuma dipakai sebagai daftar 26 kunci beserta tipe dan nilai default-nya:

- `electron/core.ts` meng-import XML itu sebagai teks (`?raw`). `parseSchema()` lalu membacanya dengan regex, dan `parseVariant()` mengurai default dalam notasi GVariant (`'system'`, `[('a', 1)]`).
- `<summary>` dan `<description>` tidak dibaca kode mana pun. Isinya hanya ikut diekstrak ke `po/markwork.pot` lewat `POTFILES.in`.

Penggantinya `src/base/settingskeys.ts`: objek TypeScript biasa berisi kunci, tipe, nilai default, dan pilihan untuk enum. Default ditulis sebagai nilai JS, bukan teks GVariant.

```ts
export const SETTING_KEYS = {
    'color-scheme': { type: 's', default: 'system', choices: ['system', 'light', 'dark'] },
    autosave: { type: 'b', default: true },
    // …
} satisfies Record<string, SettingSpec>;
```

- `JsonSettingsStore` langsung menerima `SETTING_KEYS`. `parseSchema()`, `parseVariant()`, `unescape()`, dan impor `?raw` dihapus.
- Kode tipe (`'b'`, `'s'`, `'a(si)'`, …) tetap dipakai dulu, karena validasi `JsonSettingsStore` bergantung padanya. Menggantinya dengan tipe yang lebih jelas bisa dikerjakan belakangan.
- Kalau `settings.json` milik pengguna masih punya kunci yang tidak ada di daftar, kunci itu ditolak, sama seperti sekarang.
- `nodeplatform.ts` mengetes daftar ini langsung, tidak lagi membaca XML.

## Yang harus disesuaikan

| Pemindahan | Berkas yang ikut berubah |
| --- | --- |
| `src/base/`, `src/orchestrator/` | impor relatif di seluruh `src/` dan `tests/unit/`, `scripts/layers.mjs` (`BASE`, `isCore`), `electron/core.ts`, bagian Layers dan peta folder di README.md dan AGENT.md |
| `renderer/components|lib|styles` | impor di renderer, `components.json` (`css`, alias `components`), `scripts/electron-build.mjs` (path renderer), `index.html` |
| `tests/*` | `package.json` (`test:*`, `live*`, `bench*`), `vite.node.config.ts` (entry), `tsconfig.json` dan `tsconfig.node.json` (include/exclude), `.github/workflows/` (`test:electron:run`), impor `electron-support.mjs` |
| `resources/` | `electron-builder.yml` (`buildResources`, `entitlements`), `scripts/make-icon.cjs` |
| skema setting → `src/base/settingskeys.ts` | `electron/core.ts:8`, `src/platform/node/settings.ts`, `tests/unit/nodeplatform.ts`, `po/POTFILES.in`, `scripts/pot.sh`, komentar di `src/settings.ts` dan `src/platform/index.ts` |
| `docs/design/mockups/` | tautan di README.md dan dokumen desain |

## Urutan PR

Setiap PR harus lolos `npm run typecheck` dan `npm test` sendiri-sendiri. Satu PR menyentuh satu area, jadi tidak ada konflik di antaranya:

1. **Hapus sisa:** `shots/`, `symbolic/`, `journal/` (+ `.gitignore`), dan `docs/mockups/` → `docs/design/mockups/`.
2. **Skema setting tanpa GSettings, lalu `resources/`:** XML diganti `settingskeys.ts`, kemudian `data/` dan `build/` digabung. Dua langkah ini satu PR karena sama-sama mengosongkan `data/`.
3. **`tests/`** dipecah per jenis.
4. **`src/base/` dan `src/orchestrator/`**, termasuk menyederhanakan `layers.mjs`.
5. **Renderer:** `components/`, `lib/`, `styles/`.

PR 2 sampai 5 tidak saling bergantung. Hanya PR 4 yang perlu memindahkan `settingskeys.ts` ke `src/base/` kalau PR 2 sudah masuk lebih dulu. PR 4 dan 5 yang paling besar, karena berisi impor yang diubah secara mekanis.

## Di luar rancangan ini

- Berhenti memakai gettext (`po/`, `.po`/`.mo`). Terjemahan antarmuka tetap jalan lewat gettext, dan gettext tidak terikat GTK.
- Memecah README.md (103 KB) jadi beberapa dokumen.
- `.claude/worktrees/` (787 MB, tidak di-track) cukup dibersihkan dengan `git worktree prune` setelah worktree-nya dihapus.
