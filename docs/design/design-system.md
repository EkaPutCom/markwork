# Rencana design system UI

25 Oktober 2026 · Eka Putra

## Tujuan

Agent yang menulis UI baru menghasilkan tampilan yang konsisten dengan yang sudah ada. Konsistensi itu datang dari aturan yang dibaca agent dan tes yang gagal kalau aturannya dilanggar, bukan dari katalog visual.

## Keputusan

- **Pembaca utama: agent.** Aturan ditulis supaya bisa diikuti tanpa melihat layar.
- **Identitas tetap seperti sekarang:** shadcn/ui "new-york", basis zinc, Geist dan Geist Mono, light/dark lewat `data-theme`. Acuannya mockup di [`shadcn/`](shadcn/).
- **Tampilan isi editor ikut dicakup:** heading, list, task, tabel, code box, diagram, gambar, konflik, mode visual dan source.
- **Komponen buatan sendiri dimigrasi ke primitif `ui/`** secara bertahap.
- **Penjaga masuk `npm test`.**
- **Tanpa Storybook.** Komponen di `electron/renderer/components/` hampir semuanya membaca `client` langsung, jadi Storybook menuntut refactor view/container di ~36 komponen hanya supaya bisa dirender. Story yang tidak diperbarui pun tidak memecahkan tes. Galeri dev di dalam app memakai `client` dan editor yang asli, jadi tidak perlu mock. Storybook bisa ditambahkan nanti kalau ada kontributor UI lain atau kebutuhan visual regression; tahap 1 sampai 3 tetap terpakai.
- **Pemisahan view/container tidak diwajibkan.** Boleh dipakai untuk komponen yang sudah terlalu rumit (Board, Chat).
- **Skala teks tujuh ukuran,** termasuk 11px (`text-2xs`) dan 13px (`text-ui`) seperti di mockup.
- **Tooltip wajib untuk tombol ikon** lewat `IconButton`; `title` hanya untuk nilai lengkap teks yang terpotong.
- **Satu palet kategori delapan warna bernama** (`--cat-red` … `--cat-gray`, nama dari `OPTION_COLORS`) untuk opsi, tag, cover, chart, dan avatar.

Rincian ketiga keputusan terakhir ada di bagian Keputusan di [`ui-inventaris.md`](ui-inventaris.md#keputusan).

## Kondisi awal

Diukur pada 25 Oktober 2026:

| Ukuran | Jumlah |
| --- | --- |
| Elemen mentah (`<button>`, `<input>`, `<select>`, `<textarea>`) di `components/` | 283 |
| Style inline (`style={{…}}`) di `components/` | 37 |
| Warna literal di `theme.css` (1211 baris) | 140 |
| Primitif di `electron/renderer/ui/` | 7 |

Karena pelanggarannya sebanyak ini, penjaga bekerja sebagai **ratchet**: file baseline menyimpan jumlah pelanggaran per file, dan jumlah itu hanya boleh turun. Kode baru harus bersih, kode lama dibersihkan bertahap.

## Tahapan

### Tahap 0: Inventaris

**Selesai** (25 Oktober 2026). Analisis, tanpa perubahan kode. Hasilnya [`ui-inventaris.md`](ui-inventaris.md).

- Class di `theme.css`: mana yang tampilan umum dan mana yang khusus editor atau CodeMirror.
- Elemen mentah dan style inline per komponen, dengan primitif pengganti masing-masing.
- Primitif shadcn yang benar-benar dibutuhkan, berdasarkan pemakaian nyata.
- Daftar semua elemen tampilan editor.

### Tahap 1: Aturan tertulis

**Selesai** (25 Oktober 2026): [`ui.md`](ui.md), dirujuk dari bagian "The look of the window" di `AGENT.md`. Ditulis dalam bahasa Inggris seperti `AGENT.md`, karena pembaca utamanya agent.

- Token warna dan kapan memakai masing-masing, tipografi, skala spacing, radius, ikon lucide.
- Kapan memakai primitif mana (Dialog, Popover, Menu, …).
- Pola status (selalu dengan teks), state kosong, error.
- Aturan tampilan isi editor.
- Larangan: warna literal, elemen mentah, spacing inline, class baru di `theme.css` untuk hal yang sudah punya primitif.

### Tahap 2: Penjaga di `npm test`

**Selesai** (25 Oktober 2026): `scripts/ui.mjs` dan `scripts/ui-baseline.json`, dijalankan di `npm run typecheck` dan `test:core:node` sesudah `scripts/layers.mjs`. Baseline awal: 933 temuan di 45 file (288 elemen mentah, 285 class lama, 182 ukuran teks px, 159 warna, 10 tombol ikon, 0 style konstan). Cara pakainya ada di bagian "What the guard checks" di [`ui.md`](ui.md).

- Gagal pada warna literal di luar file token, elemen mentah di luar `ui/`, `style={{}}` tanpa alasan.
- Nilai dinamis yang sah (posisi atau indentasi hasil hitungan) diberi komentar penanda.
- Baseline ratchet dibuat dari kondisi sekarang.

### Tahap 3: Melengkapi fondasi

**Selesai** (25 Oktober 2026). Command dan Sonner ditambahkan di tahap 5 bersama palet perintah dan toast yang memakainya.

- Primitif hasil tahap 0 ditambahkan ke `ui/`: 19 dari shadcn (termasuk Tooltip), ditambah `IconButton` milik Markwork. 17 di antaranya sudah ada, ditambah Toggle sebagai dasar ToggleGroup. Command dan Sonner menunggu tahap 5: keduanya butuh paket `cmdk` dan `sonner`, jadi baru ditambahkan bersama migrasi palet perintah dan toast yang memakainya.
- Skala teks tujuh ukuran dan palet `--cat-*` ditambahkan ke file token.
- Warna literal di `theme.css` diganti token, dan alias token di kepala `theme.css` diganti token shadcn.

### Tahap 4: Galeri dev di dalam app

**Selesai** (25 Oktober 2026): `electron/renderer/components/UiGallery.tsx`, dibuka dengan `Ctrl+Alt+G` hanya di mode dev (`npm start`, `MARKWORK_DEV=1`). Dokumen contohnya `tests/samples/ui-gallery.md`, dibuka lewat tombol Open Sample Document sebagai salinan di folder data app (`main.ts`, `ui-gallery-sample`), jadi menyuntingnya tidak mengubah file di repo. Tesnya `tests/electron/ui-gallery.mjs`.

- Satu layar mode dev: semua primitif dan keadaannya, light dan dark.
- Satu dokumen contoh Markdown yang memuat semua elemen editor.
- Satu tes Electron yang membuka galeri.

### Tahap 5: Migrasi komponen

**Selesai** (26 Oktober 2026): tidak ada lagi temuan di `components/` dan `App.tsx`. Baseline turun dari 583 ke 13, semuanya widget `lib/` yang menjadi bagian tahap 6.

- Outline, EditingMode, dialog inti (`AlertDialog`), tombol tutup tab dokumen, dan palet perintah (`Command` dari paket `cmdk`) lebih dulu, dalam PR kecil. Sisanya dalam satu PR.
- `Modal` di `Modals.tsx` sekarang `Dialog`; semua dialog tugas (Preferences, Fields, kartu, Harness, Collab, laporan masalah, viewer History, log) ikut. `hidden` menyembunyikannya sebentar tanpa menutupnya (gambar editor di laporan masalah).
- Toast memakai Sonner (`ui/sonner.tsx`). Menu klik kanan dan menu di titik pointer memakai `ContextMenu` dan `DropdownMenu` (dengan submenu); popover field dan popover Assistant memakai `Popover`.
- Chip menjadi `Badge` dengan class `note-chip`; pilihan yang menyatu (ukuran galeri, zoom timeline, mode kalender, filter log, Live/Paused) menjadi `ToggleGroup`, jadi tesnya mencari `radio`. Tab di dialog dan panel menjadi `Tabs`; kotak centang menjadi `Checkbox`, jadi tesnya mencari `checkbox`.
- Dua pengecualian dengan `ui-allow`: sel grid CSV (field polos yang digambar grid itu sendiri) dan input file yang tersembunyi di Replay.
- Class lama di `theme.css` (`.button`, `.popover`, `.dialog`, switch dan tab buatan sendiri, `.icon-button`, `.linked`, aturan entry bersama) dihapus: dari 1180 ke sekitar 1030 baris.

### Tahap 6: Tampilan editor

- Style CodeMirror dan widget (tabel, code box, diagram, gambar) memakai token dan mengikuti `ui.md`.
- Widget `lib/` yang masih membuat kontrolnya sendiri (blockhandle, blocktools, conflicts, editor, visual, sisa find bar) pindah ke `domButton` dan helper `ui/dom.ts` lain: 13 temuan terakhir di baseline.
- Dicek di dokumen contoh tahap 4.

### Tahap 7: Penutup

- Baseline nol, file baseline dihapus, penjaga ketat penuh.
- `ui.md` diperbarui dengan kondisi akhir.

Tahap 1 dan 2 sengaja ditempatkan sebelum migrasi. Begitu keduanya ada, UI baru, termasuk yang ditulis agent selama migrasi, sudah terjaga.
