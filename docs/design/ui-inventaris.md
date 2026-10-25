# Inventaris UI

25 Oktober 2026 · Eka Putra · tahap 0 dari [`design-system.md`](design-system.md)

Kondisi renderer (`electron/renderer/`) pada commit `a0a0951`. Catatan ini adalah dasar tahap 1 (aturan), tahap 2 (penjaga), dan tahap 3 (fondasi); angkanya diukur dengan `grep`, jadi angka yang tepat dihitung ulang oleh penjaga di tahap 2.

## Temuan utama

1. **Dua sistem tombol hidup berdampingan.** Primitif `ui/button.tsx` (shadcn `Button`) dipakai 20 kali di 6 file. Sementara itu `theme.css` menggambar tombol sendiri lewat class: `.button` (outline), `.flat` (ghost), `.suggested` (default), `.circular`, `.icon-button`, dipakai sekitar 150 kali. Keduanya meniru shadcn, tapi dengan ukuran dan state yang tidak dijamin sama.
2. **`theme.css` meniru 14 komponen shadcn dengan CSS buatan sendiri:** AlertDialog, Dialog, Badge, ButtonGroup, Card, Checkbox (2×), Command (2×), DropdownMenu, Input, Select, Sidebar, Sonner, Switch, Tabs. Komentarnya sendiri menyebut "shadcn's X". Ini sasaran utama migrasi: ganti tiruan dengan primitif yang asli.
3. **Ada dua lapis token.** Token shadcn di `globals.css` (`--background`, `--muted-foreground`, …), lalu alias di kepala `theme.css` (`--bg`, `--fg-dim`, `--row-hover`, `--btn-checked`, …) yang hanya meneruskan token shadcn. 30 alias, beberapa tidak dipakai sama sekali (`--fg-dim`, `--header-bg`, `--rail-bg`, `--btn-bg`, `--tab-active`, `--quote-bg`). Agent tidak tahu harus memakai lapis yang mana.
4. **Lima palet "warna kategori" yang tidak sama.** Tag dan opsi field punya delapan warna, tapi ditulis lima kali dengan nilai berbeda: `.opt-*`, `.opt-dot-*` (salinan `.opt-*`), `.tag-*`, `.cover-*`, dan `hue-*` untuk avatar (enam warna). `Chart.tsx` menyalin palet `.cover-*` di JavaScript (`FALLBACK`).
5. **Style inline hampir semuanya sah.** Dari 37 `style={{…}}`, hampir semuanya posisi atau ukuran hasil hitungan (Csv, Timeline, ImageViewer, pane, menu klik kanan). Yang bukan: indentasi pohon dengan angka ajaib (`12 + level * 14` di Outline, `10 + depth * 20` di Explorer, `4 + depth * 14` di LogViewer) dan warna di Chart.
6. **Skala ukuran belum ada.** Nilainya mendekati skala, tapi banyak yang menyimpang.

## Token dan nilai

### Warna literal

140 nilai warna literal di `theme.css`, ditambah beberapa di `Chart.tsx`. Kelompoknya:

| Kelompok | Di mana | Rencana |
| --- | --- | --- |
| Delapan warna kategori (tag, opsi, cover, avatar) | `.opt-*`, `.opt-dot-*`, `.tag-*`, `.cover-*`, `.avatar.hue-*`, `Chart.tsx` | Satu palet bernama `--cat-<nama>` (keputusan 3) |
| Warna sintaks kode (One Light / One Dark) | `--tok-*` | Tetap, dipindah ke file token sebagai keluarga `--tok-*` |
| Konflik Git | `--cf-*` | Tetap, dipindah ke file token |
| Sorotan pencarian dan `mark` | `--mark-bg`, `.cm-searchMatch` (amber literal), `.hit mark` (`#e5c07b`), `.csv-cell.match` (oranye literal) | Satu keluarga `--highlight` dan `--highlight-strong`; empat tempat itu membacanya |
| Lapisan gelap di atas konten | `rgb(0 0 0 / 20%)`, `/ 50%`, `#00000052`, `#00000047`, `#0000002e`, `#000000a6`, `#000000cc` | Dua token: `--overlay` (backdrop dialog) dan `--scrim` (di atas gambar) |
| Bayangan | `--shadow` dan `box-shadow` literal di sidebar mengambang | Pakai `shadow-*` Tailwind/shadcn; `--shadow` dihapus |
| Kanvas khusus | `.image-viewer .area` `#1c1d20`, `.html-page iframe` `#fff`, teks avatar `#fff` | Token khusus yang diberi nama: `--canvas-dark`, `--on-cat` |

### Alias di `theme.css`

Usulan untuk tahap 1: **satu lapis token saja, yaitu token shadcn.** Alias yang hanya meneruskan (misalnya `--bg` → `--background`) diganti langsung dengan token shadcn, lalu dihapus. Alias yang memang punya arti sendiri dipertahankan dan dipindah ke `globals.css` di samping `--success` dan `--warning`:

- Dipertahankan: `--heading`, `--link`, `--code-bg`, `--code-fg`, `--quote-fg`, `--sel`, `--column-bg`, `--faint`, `--mark-bg` (menjadi `--highlight`)
- Diganti token shadcn: `--bg`, `--fg`, `--fg-dim`, `--window-bg`, `--header-bg`, `--sidebar-bg`, `--rail-bg`, `--btn-hover`, `--btn-checked`, `--btn-bg`, `--row-active`, `--row-hover`, `--tab-active`, `--quote-bg`, `--card-bg`, `--popover-bg`, `--toast-bg`, `--toast-fg`, `--error`, `--font-text`

### Ukuran yang dipakai

Jumlah pemakaian di `theme.css`:

| Ukuran | Nilai (pemakaian) | Usulan skala |
| --- | --- | --- |
| `gap` | 8px (60), 6px (46), 2px (30), 4px (19), 12px (18), 10px (16), 16px (8), 14px (2), 3px, 20px, 1px | Skala Tailwind: 2, 4, 6, 8, 12, 16, 24px (`gap-0.5` … `gap-6`); 10px dan 14px dibulatkan |
| `padding` | `0 8px` (20), `0 6px`, `0 10px`, `0 12px`, `6px 8px`, `6px 10px`, `12px`, `8px`, `4px`, … | Skala yang sama |
| `font-size` | 12px (58), 14px (42), 13px (20), 11px (15), 16px, 18px, 26px, 28px, 12.5px, 11.5px, 15px | Tujuh ukuran resmi, termasuk 11px dan 13px (keputusan 1) |
| `border-radius` | 6px (43), 8px (29), `var(--radius)` (20), 4px (18), 3px, 2px, `calc(var(--radius) - 2px)`, 50%, 5px, 1px | Hanya `rounded-sm/md/lg/xl` yang diturunkan dari `--radius`, plus `rounded-full` |

## Elemen mentah per komponen

Hitungan `<button>`, `<input>`, `<textarea>` (tidak ada `<select>` mentah: `ui/select` sudah dipakai di 8 file). Kolom terakhir adalah primitif `ui/` yang sudah diimpor.

| Komponen | button | input | textarea | style | Sudah memakai |
| --- | ---: | ---: | ---: | ---: | --- |
| Chat | 25 | 6 | 1 | 0 | select |
| Review | 18 | 1 | 1 | 0 | |
| FieldsDialog | 13 | 3 | 0 | 0 | select |
| Harness | 12 | 5 | 3 | 0 | |
| Pull | 11 | 0 | 1 | 0 | select |
| notes | 11 | 8 | 1 | 2 | select |
| Inspector | 11 | 0 | 0 | 0 | |
| History | 11 | 1 | 1 | 0 | |
| Csv | 10 | 3 | 0 | 9 | |
| Collab | 10 | 5 | 1 | 0 | |
| LogViewer | 8 | 0 | 0 | 1 | |
| InspectorReplay | 8 | 2 | 0 | 0 | |
| Search | 7 | 4 | 0 | 0 | |
| Calendar | 7 | 0 | 0 | 0 | |
| Chart | 6 | 0 | 0 | 3 | select |
| ReportProblem | 5 | 3 | 1 | 0 | |
| AgentsPrefs | 5 | 3 | 0 | 0 | select |
| Modals | 4 | 2 | 0 | 0 | select |
| Home | 4 | 1 | 0 | 0 | button |
| Explorer | 4 | 0 | 0 | 3 | |
| Board | 4 | 1 | 0 | 0 | |
| Timeline | 3 | 0 | 0 | 9 | |
| TableView | 3 | 2 | 0 | 0 | |
| Sidebar | 3 | 0 | 0 | 1 | |
| ImageViewer | 3 | 0 | 0 | 3 | |
| FilesView | 3 | 0 | 0 | 0 | button, dropdown-menu |
| App | 3 | 0 | 0 | 0 | button, dropdown-menu |
| Inbox | 2 | 1 | 0 | 0 | |
| Gallery | 2 | 1 | 0 | 2 | |
| EditingMode | 2 | 0 | 0 | 0 | |
| Tabs, Programs, Outline, HtmlPage, Dialog | 1 | 0–1 | 0 | 0–1 | Programs: button |
| EditorArea | 1 | 0 | 0 | 3 | button, dropdown-menu |
| Palette | 0 | 1 | 0 | 0 | |
| MenuBar, FormatBar, Icons, Diff | 0 | 0 | 0 | 0 | MenuBar: menubar; FormatBar: button, dropdown-menu |

**Widget editor di `lib/`** membuat DOM sendiri dengan `document.createElement` (8 tombol, 2 input di `visual.ts`, `blockhandle.ts`, `blocktools.ts`, `findbar.ts`, `editor.ts`, `conflicts.ts`). Di sana React tidak bisa dipakai. Aturannya: widget mengambil class dari `buttonVariants()` dan fungsi varian lain di `ui/`, jadi tampilannya tetap sama dengan primitif.

## Primitif yang dibutuhkan

Sudah ada (7): Button, Badge, DropdownMenu, Menubar, Select, Separator, Kbd.

Perlu ditambah, berdasarkan tiruan di `theme.css` dan pemakaian nyata di komponen:

| Primitif shadcn | Menggantikan | Dipakai di |
| --- | --- | --- |
| Dialog | `.dialog-backdrop` dan halaman Preferences/Shortcuts/About | Dialog, Modals, FieldsDialog, ReportProblem, Collab, Pull |
| AlertDialog | dialog tanya jawab (`role="alertdialog"`) | Dialog |
| Input | `.entry` | Search, Dialog, Csv, form di banyak dialog |
| InputGroup | entry dengan ikon kaca pembesar dan tombol di dalamnya | Search, layout pages |
| Textarea | `<textarea>` mentah (11) | Chat, Harness, Review, Collab, Pull, History, ReportProblem, notes |
| Label | label form | semua dialog form |
| Checkbox | `.check`, `.check-cell`, checkbox kartu | Chat, Board, TableView, Collab, History, Home, Review, AgentsPrefs, Modals, ReportProblem |
| RadioGroup | `.radio` | ReportProblem, Collab, Harness |
| Switch | `.switch` (`role="switch"`) | EditingMode, AgentsPrefs, Modals (Preferences) |
| Tabs | `role="tablist"` buatan sendiri di halaman dialog dan panel | Modals (Preferences), Review, History, Pull, Programs, Inspector, LogViewer; `Tabs.tsx` adalah tab dokumen dan tetap buatan sendiri |
| ToggleGroup | ButtonGroup buatan sendiri (pilihan yang terisi) | layout pages, Chart, Search (Aa ab .*) |
| Popover | `.popover` | notes, Review, Explorer |
| ContextMenu | menu klik kanan yang digambar sendiri | Explorer, Board, Csv, Inbox, Tabs |
| Command | palet perintah dan menu `/` | Palette; menu `/` di `lib/visual.ts` memakai class-nya saja |
| Sonner | `.toast` | App |
| Card | kartu board, list, proposal agent | Board, notes, Chat |
| Tooltip | `title=` di tombol ikon dan petunjuk shortcut | lihat keputusan 2 |
| IconButton (milik Markwork, di atas Button dan Tooltip) | tombol ikon dengan `aria-label` dan `title` yang sama (~60) | semua tombol yang hanya berupa ikon |
| Collapsible | bagian Files view yang bisa dilipat | FilesView |
| Spinner | `.spinner` | Chat |

Tidak dipakai dari shadcn, tetap buatan sendiri karena khusus Markwork: tab dokumen dan pane (seret, belah, zona jatuh), activity bar, pohon Files, grid CSV, timeline, kalender, diff, inspector.

**Sidebar shadcn tidak diusulkan.** Sidebar Markwork (activity bar, panel per halaman, lebar yang diseret, mode mengambang dari `layoutOf`) sudah punya perilaku sendiri. Menggantinya dengan Sidebar shadcn adalah pekerjaan besar dengan hasil kecil. Yang dirapikan cukup isinya: tombol, baris, dan judul.

## Isi `theme.css` per kelompok

**A. Tiruan shadcn: dihapus setelah komponennya pindah ke primitif.** Tombol (`.button`, `.flat`, `.suggested`, `.circular`, `.icon-button`), menu buatan sendiri, toast, palet perintah, entry, dialog, tab dialog, select di baris, switch, chip, button group, checkbox, kartu board, dialog form.

**B. Tata letak khusus Markwork: dipertahankan, memakai token dan skala.** Shell dan layout adaptif, header dokumen, activity bar, panel halaman, tepi sidebar yang diseret, Files view, tab dokumen, bar pane, garis pembagi, zona jatuh, hitungan di kaki editor, halaman Welcome dan Home, Programs, halaman catatan (board, list, tabel, kalender, timeline, galeri, chart), tab CSV, panel Assistant, diff, history, review PR, Agents, Editor Inspector, image viewer, laporan masalah.

**C. Editor dan CodeMirror: dipertahankan, dirapikan di tahap 6.** Lihat bagian berikut.

## Elemen tampilan editor

Inilah yang harus ada di dokumen contoh pada tahap 4. Semuanya diberi class `cm-md-*`. Nama sintaksnya berasal dari `SyntaxName` di `src/markdown/highlight.ts`.

**Teks dan baris**
- Heading 1–6 (`cm-md-h1` … `h6`, baris `-line`). Garis di bawah H2 digambar di padding baris.
- Inline: bold, italic, bold-italic, strike, code, mark, link, wiki link, image, marker sintaks yang diredupkan (`cm-md-marker`, `cm-md-dim`).
- Kutipan tiga tingkat (`quote`, `quote2`, `quote3`), garis horizontal (`hr`).
- List: bullet, bernomor, task terbuka dan selesai (`cm-md-bullet`, `cm-md-listmark`, `cm-md-task`, `cm-md-taskdone`, `cm-md-checkbox`), dan indentasi gantung untuk baris yang terbungkus.

**Blok dan widget**
- Code block: kotak tertutup (`cm-md-codebox`) dan saat diedit (`cm-md-codeedit`), dengan warna sintaks `--tok-*`.
- Tabel: grid (`cm-md-table-grid`, `cm-md-cell`), sel yang sedang diedit, dan bentuk sumbernya (`table`, `tablehead`, `tablesep`).
- Diagram: Mermaid dan DBML (`cm-md-diagram`), label pada panah, tabel DBML dengan badge PK/FK.
- Gambar: di bawah teks (`cm-md-pictures`, `cm-md-picture`) dan gambar yang hilang (`cm-md-picture-missing`).
- Konflik Git: sisi current, incoming, dan netral, plus bar tombolnya (`cm-md-conflict-*`).

**Interaksi**
- Pegangan blok: "+" dan grip, garis tempat blok yang diseret mendarat (`blockhandle.ts`).
- Objek yang dipilih: cincin, toolbarnya, petunjuk tombol (`blockselect.ts`, `cm-md-block-tools`).
- Mode visual: toolbar seleksi, menu `/`, editor tautan, editor gambar (`visual.ts`).
- Mode source: teks apa adanya dengan font lebar tetap.
- Find and replace (`findbar.ts`), sorotan hasil pencarian.
- Seleksi teks dan kursor.

## Keputusan

Diambil 25 Oktober 2026, setelah inventaris. Ketiganya masuk ke `ui.md` di tahap 1.

### 1. Skala ukuran teks: tujuh ukuran

Mockup acuan di `shadcn/` sendiri memakai 13px dan 11px di samping 12px dan 14px, dan aplikasi desktop yang padat memang memakai 13px untuk teks UI. Jadi keduanya masuk skala resmi lewat `@theme`:

| Token | Ukuran | Untuk |
| --- | --- | --- |
| `text-2xs` | 11px | label kapital kecil (judul bagian), hitungan, meta |
| `text-xs` | 12px | teks sekunder, badge, keterangan |
| `text-ui` | 13px | teks UI padat: tab, baris, menu, sel |
| `text-sm` | 14px | teks UI normal: tombol, form, dialog |
| `text-base` | 16px | judul kecil |
| `text-lg` | 18px | judul dialog dan halaman |
| `text-2xl` | 24px | judul besar (Home, Welcome) |

- Nilai lain dibulatkan: 11.5px → 11px, 12.5px → 12px, 15px → 14px atau 16px menurut perannya, 26px dan 28px → 24px, 10px → 11px.
- Isi dokumen di editor tidak memakai skala ini. Heading tetap `em` relatif terhadap ukuran font editor (H1 2.25em, H2 1.5em, H3 1.25em), supaya ikut membesar kalau teks diperbesar.
- Dilarang: `text-[…px]` dan `font-size` literal di luar file token.

### 2. Tooltip dan `title`

`title` bawaan muncul terlambat, tidak ikut tema, tidak muncul saat fokus keyboard, dan tidak bisa memuat `Kbd`. Aturannya per kelompok:

| Kelompok | Aturan |
| --- | --- |
| Tombol yang hanya berupa ikon | Wajib `IconButton` dengan `label` (dan `shortcut` bila ada); satu prop mengisi `aria-label` dan Tooltip sekaligus |
| Tombol berteks | Tanpa `title`; perbaiki labelnya, atau tulis deskripsi yang terlihat |
| Petunjuk shortcut | Tooltip dengan `Kbd` (`IconButton shortcut=…`, atau Tooltip langsung untuk tombol berteks) |
| Teks yang terpotong (nama file, judul, path) | `title` dengan nilai lengkapnya tetap boleh |
| Pesan error | Dilarang di `title`; error ditulis terlihat di bawah field, dengan `aria-invalid` pada input |

- Widget editor di `lib/` (6 `title`) sementara tetap memakai `title`, dirapikan di tahap 6.
- Primitif baru untuk tahap 3: Tooltip (shadcn) dan IconButton (milik Markwork).
- Penjaga tahap 2 menolak tombol berukuran ikon yang tidak memakai `IconButton`.

### 3. Palet kategori: satu palet delapan warna bernama

Dua konsep yang selama ini ditulis lima kali:

- Warna opsi bernama yang dipilih pengguna (`option:color` di dokumen, `OPTION_COLORS` di `src/markdown/fields.ts`). Ditulis di `.opt-*`, `.opt-dot-*`, dan `SLICE_COLORS` di `Chart.tsx`, yang nilainya berbeda untuk nama yang sama.
- Warna menurut urutan dari hash nama tag (`tagColor`, `tagColorIndex`). Ditulis di `.tag-*`, `.cover-*` (urutan sama, versi kalem), `FALLBACK` di `Chart.tsx`, dan `.avatar.hue-*` (enam warna sendiri).

Keputusannya:

- Delapan token dengan nama `OPTION_COLORS`: `--cat-red`, `--cat-amber`, `--cat-green`, `--cat-blue`, `--cat-purple`, `--cat-teal`, `--cat-pink`, `--cat-gray`.
- Nilai Tailwind 600 di light (cukup gelap untuk huruf putih) dan 500 di dark.
- Ditambah `--on-cat` (teks di atas warna kategori) dan `--cat-none` (irisan chart tanpa nilai).
- Urutan tag dan cover dipetakan ke nama: green, blue, purple, red, pink, teal, amber, gray. Avatar memakai enam yang pertama.
- Semua tempat membaca token ini: chip dan titik opsi, tag, cover, chart, avatar. `FALLBACK` dan `SLICE_COLORS` di `Chart.tsx` dihapus.
- Nama opsi adalah data pengguna yang tersimpan di dokumen, jadi tidak berubah. Yang berubah hanya nilai warnanya.

Perubahan yang terlihat pengguna: chip dan titik opsi di light sedikit lebih gelap; cover galeri lebih jenuh; tag urutan ke-4 berubah dari orange ke red dan ke-7 dari yellow ke amber; chart kini sewarna dengan chip opsinya; avatar memakai warna palet.
