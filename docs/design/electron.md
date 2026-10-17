# Arsitektur Markwork dan jalan menuju Electron

17 Oktober 2026 · Eka Putra · salinan dari [doc Claude](https://claude.ai/code/artifact/86001ae8-365a-41e1-b0b5-cf4e07c2ef3b)

## Ringkasan

Fondasi untuk frontend kedua sudah selesai, tetapi protokol yang dibutuhkan Electron belum ditulis satu baris pun. Core sudah berjalan di Node (632 tes core lulus di Node v24), dan `AppSession` sudah memegang semua keputusan aplikasi. Antarmuka ke frontend juga sudah hanya menerima data biasa.

Electron tidak memerlukan sidecar terpisah karena sudah membawa Node. Core cukup berjalan di *utility process* dan berbicara dengan renderer lewat `MessagePort`. Pekerjaan yang tersisa adalah lapisan `app/protocol/`, entry point untuk utility process, dan frontend web-nya sendiri, termasuk perintah editor untuk CodeMirror.

## Arsitektur saat ini

Codebase terdiri dari empat lapisan, dan setiap lapisan hanya bergantung pada lapisan di bawahnya. Frontend GTK memanggil `AppSession` langsung di prosesnya sendiri. Jalur untuk Electron sudah dirancang, tetapi belum ada kodenya.

![Lapisan codebase; garis putus-putus = belum ada](electron/arsitektur.png)

Kotak yang disorot adalah tempat semua keputusan aplikasi. Kotak bergaris putus-putus adalah bagian yang belum dibuat.

| Lapisan | Folder | Tugas |
| --- | --- | --- |
| Frontend | `src/window.ts`, `src/ui/`, `src/editor/` | Widget GTK, editor GtkSourceView, highlight, perintah editor |
| Aplikasi | `src/app/` | `AppSession` dan controller fitur; memutuskan dokumen, simpan, board, agent, history |
| Core | `src/markdown/`, `src/agent/`, `src/forge/`, modul dasar | Aturan Markdown, agent dan aturan persetujuannya, git, forge, harness |
| Port runtime | `src/platform/index.ts` | Kontrak tunggal yang diisi oleh `platform/gjs` atau `platform/node` |

## Pengaman yang menjaga batas lapisan

Batas lapisan dijaga otomatis oleh pemeriksaan di build dan tes, bukan sekadar konvensi. Setiap daftar pengecualian sekarang kosong dan hanya boleh menyusut.

| Aturan | Dicek oleh | Pengecualian saat ini |
| --- | --- | --- |
| Core tidak mengimpor `gi://`, built-in GJS, `platform/gjs/`, atau `app/` | `scripts/layers.mjs` (`GI_ALLOWED`) | kosong |
| `app/` hanya mengimpor core dan `app/`, tanpa GTK | `scripts/layers.mjs` | — |
| View di `ui/` tidak mengimpor modul core yang menyentuh runtime | `scripts/layers.mjs` (`UI_ACTS_ALLOWED`) | kosong |
| Anggota `AppFrontend` dan `AppDialogs` hanya menerima dan mengembalikan data biasa | `tests/unit/plaindata.ts` (`KNOWN`), lewat `tsc` | kosong |
| Controller tidak membaca balik tulisannya sendiri sebelum tulisan itu sampai | `LaggingEditor` di `tests/unit/appsession.ts`, di GJS dan Node | — |
| Kontrak runtime sama di GJS dan Node | `tests/unit/platform.ts`, `npm run test:core:node` | — |

Aturan data biasa inilah yang membuat protokol nanti cukup menjadi penerjemah tipis. Setiap pemanggilan `AppFrontend` bisa langsung dibungkus menjadi satu pesan JSON.

## Bentuk proses aplikasi Electron

Core berjalan di *utility process* Electron, bukan di sidecar terpisah dan bukan di renderer. Main process hanya membuat jendela dan menghubungkan kedua sisi.

![Proses Electron; core di utility process](electron/proses-electron.png)

- **Bukan sidecar.** Electron sudah membawa Node, jadi `platform/node` jalan di dalamnya. Sidecar stdio (`src/sidecar.ts`) hanya untuk Tauri dan GPUI.
- **Bukan renderer.** Core butuh file, proses, dan keyring; membukanya di renderer berarti mematikan `contextIsolation`. Pekerjaan git dan agent juga akan berebut thread dengan ketikan.
- **Bukan main process.** Kalau core ikut di main, pekerjaan berat membuat menu dan jendela macet. Utility process yang crash tidak menutup jendela, dan teks yang belum disimpan tetap aman di renderer.
- **Editor tetap di renderer.** Ketikan tidak pernah menyeberang proses sebelum layar berubah. Core menerima perubahan sebagai `doc.edit` kecil setelahnya, dan menulis balik lewat `doc.replace` dengan versi dasar (bagian 5 [dokumen protokol](protocol.md)).

## Tahapan membuat aplikasi Electron

Urutannya: protokol diuji dulu tanpa UI, lalu satu irisan tipis dari ujung ke ujung, baru kemudian semua view. Tahap 1–3 mengikuti langkah 2–4 di [`docs/design/protocol.md`](protocol.md) bagian 15. Tahap 0 dan 4–7 khusus untuk Electron.

0. **Putuskan arah.**
   - `AGENT.md` mewajibkan GNOME HIG dan menolak tampilan bergaya web atau Electron. Aturan ini perlu ditulis ulang untuk frontend Electron, misalnya hanya berlaku bagi frontend GTK.
   - Pilih editor (CodeMirror 6 adalah kandidat yang disebut dokumen protokol) dan framework UI renderer.
   - Platform target: Linux, macOS, dan Windows. Di Linux, `secret-tool` cukup untuk keyring; macOS dan Windows butuh implementasi `Secrets` lain di `platform/node`.
1. **Inti protokol, tanpa UI** (`src/app/protocol/`).
   - `messages.ts`: tipe semua pesan (request, reply, notice) sesuai bagian 4.2.
   - `replica.ts`: teks dan versi dokumen di core, `ProtocolEditor` yang mengimplementasikan `TextEditor`, termasuk `doc.edit`, `doc.replace` dengan `base`, dan `conflict`.
   - Tes fuzz replica dan skenario race dari bagian 10.2 dan 12.
   - `framing.ts` (baris JSON) tidak dibutuhkan Electron; cukup dibuat saat Tauri atau GPUI dimulai.
2. **Adapter frontend dan server.**
   - `frontend.ts`: `ProtocolFrontend` mengimplementasikan `AppFrontend` dengan mengirim notice dan ask.
   - `server.ts`: meneruskan request (perintah, aksi, jawaban) ke `AppSession`, termasuk `hello` dan `start` (bagian 4.5).
   - Fake frontend di Node menjalankan `AppSession` asli lewat protokol, di memori. Skenario yang sama juga dijalankan terhadap binding in-process GTK.
3. **Entry point core untuk Electron** (misalnya `src/electron/core.ts`).
   - Memasang `platform/node`, membuat `AppSession`, dan menyambungkan `server.ts` ke `MessagePort` (satu objek per post, tanpa framing baris).
   - Membundel teks schema GSettings untuk `JsonSettingsStore` dan menyertakan katalog `.mo` untuk `platform/node/i18n.ts`.
   - Dibangun lewat konfigurasi Vite untuk Node, seperti `vite.node.config.ts`.
   - Membuat `platform/node` jalan di macOS dan Windows, karena saat ini masih mengasumsikan Linux:
     - `Secrets` memakai `secret-tool`; ganti dengan `safeStorage` milik Electron atau keychain OS (Keychain macOS, Credential Manager Windows).
     - `configDir`, `runtimeDir`, dan folder data memakai jalur XDG (`~/.config`, `~/.cache`, `~/.local/share`); pakai jalur OS, misalnya dari `app.getPath` yang diteruskan ke core.
     - Memindahkan ke Trash menulis Trash freedesktop (`platform/node/files.ts`); pakai `shell.trashItem` atau API OS.
     - Pencarian executable (`platform/node/process.ts`) mengasumsikan pemisah `/` dan tanpa `PATHEXT`, jadi `git.exe` di Windows tidak ketemu.
     - Audit path di core: pemisah `\` dan huruf drive Windows, serta perbandingan path yang tidak membedakan huruf besar-kecil di macOS dan Windows.
     - Jalankan `npm run test:core:node` di CI untuk ketiga OS.
4. **Kerangka Electron.**
   - Main process: membuat `BrowserWindow`, menjalankan core dengan `utilityProcess.fork`, membuat `MessageChannelMain`, dan mengirim satu port ke core dan satu ke renderer.
   - Preload: menyerahkan port ke renderer lewat `contextBridge`, dengan `contextIsolation` aktif, `sandbox` aktif, dan `nodeIntegration` mati.
   - Layanan milik frontend (bagian 9.1): `open.uri` lewat `shell.openExternal`, notifikasi desktop, laporan `window.active`, dan dialog file yang menjawab `ask.file`.
   - Kalau core keluar: tampilkan potongan log stderr dan tawarkan restart. Teks yang belum disimpan aman di renderer.
5. **Irisan pertama dari ujung ke ujung.** Buka folder, buka dokumen board, pindahkan kartu, lihat teks berubah, lalu simpan.
   - Di irisan ini juga diukur pertanyaan terbuka bagian 16: undo dari dua sisi di CodeMirror, interval penggabungan edit 100 ms, dan seberapa ketat rebase.
6. **Editor di renderer.**
   - Konversi offset UTF-16 (CodeMirror) ke code point (protokol) di tepi editor.
   - Tulis ulang perintah editor (`editor/editing.ts`, `editor/tableedit.ts`, indentasi list) untuk CodeMirror, sebaiknya setelah logika teksnya dipisahkan dari `Gtk.TextBuffer` supaya bisa dipakai bersama.
   - Highlight Markdown, popover `[[` dari cache jawaban `ask.notes`, dan menu milik view.
7. **Semua view dan ask, satu controller demi satu controller.**
   - Board, list, table, calendar, timeline, gallery, chart, Assistant dan log agent, history, search, outline, preferences.
   - Setiap view dicek perilakunya terhadap frontend GTK sebagai rujukan.
   - Setelah itu: packaging (electron-builder atau Forge), pembaruan otomatis, dan pengujian di Linux, macOS, dan Windows, termasuk tanda tangan kode di Windows serta notarisasi di macOS.

## Bagaimana dengan GPUI

GPUI adalah framework Rust, jadi frontend-nya tidak bisa memanggil logika teks TypeScript di proses yang sama. Core berjalan sebagai sidecar Node lewat stdio, dan di situlah `framing.ts` baru dibutuhkan. Untuk perintah editor ada tiga pilihan:

| Pilihan | Cara kerja | Kelebihan | Kekurangan |
| --- | --- | --- | --- |
| Tulis ulang di Rust | Logika perintah di-port ke frontend GPUI | Instan, tanpa proses lain | Salinan ketiga; masalah perintah ditulis dua kali makin parah |
| Jalankan di core | Perintah menjadi `runs: 'core'`: frontend mengirim perintah dan seleksi, core membalas `doc.replace` dengan versi dasar | Satu sumber logika; `conflict` di protokol sudah menangani balapan | Satu putaran bolak-balik lewat stdio |
| Sematkan mesin JS | Logika TS dijalankan di proses GPUI lewat QuickJS atau WASM | Satu sumber, tetap lokal | Rumit dan berat untuk keuntungan kecil |

![Perintah editor di tiga frontend; GPUI lewat core](electron/gpui.png)

Sarannya campuran, dibagi menurut apakah perintah itu terikat ke ketikan:

- **Perintah toolbar dan menu** (bold, link, heading, quote, operasi baris dan kolom tabel, perataan) dijalankan di core. Perintah ini dipicu klik, jadi jeda beberapa milidetik tidak terasa.
- **Perintah yang terikat ke tombol** (Enter yang melanjutkan list, Tab dan Enter di tabel) di-port ke Rust, hanya yang ini saja. Kalau perintah ini menunggu core, ketikan bisa tersendat; ini pelajaran dari Xi Editor.
- Highlight Markdown (misalnya dengan tree-sitter) dan konversi offset (byte UTF-8 di Rust, code point di protokol) juga ditulis di Rust.

Apa pun pilihannya, langkah pertamanya sama: memisahkan logika teks dari `Gtk.TextBuffer`. Setelah itu, memindahkan sebuah perintah ke core cukup dengan mengganti `runs`.

## Risiko dan pertanyaan terbuka

- **Perintah editor ditulis dua kali.** Perintah editor masih terikat ke `Gtk.TextBuffer`. Tanpa pemisahan logika teks dulu, setiap perbaikan harus dilakukan di GTK dan CodeMirror. *Pembaruan 17 Oktober 2026: logika teks sudah dipisah ke `src/markdown/editcommands.ts`, dan adaptor GTK-nya ada di `src/editor/textedit.ts`. Adaptor CodeMirror menyusul.*
- **Perilaku yang berbeda dari GTK.** Frontend GTK tetap menjadi rujukan. Tanpa skenario yang dijalankan di kedua sisi (bagian 12), perbedaan kecil seperti undo langkah kartu atau rebase yang ditolak akan lolos.
- **Keyring dan jalur di macOS dan Windows.** `platform/node` memakai `secret-tool`. Karena macOS dan Windows juga target, implementasi `Secrets` itu gagal dan perlu diganti (misalnya dengan `safeStorage` milik Electron atau keychain OS). Jalur XDG, Trash freedesktop, dan pencarian executable juga masih mengasumsikan Linux (lihat tahap 3).
- **Ukuran dokumen.** Seluruh teks dikirim saat `doc.open`. Untuk file beberapa MB ini masih wajar, tetapi perlu diukur di irisan pertama.
- **Satu jendela per core.** Beberapa jendela Electron butuh satu utility process per jendela, atau kepemilikan dokumen per jendela. Untuk versi awal, cukup satu jendela.
- **Kebijakan desain.** Selama `AGENT.md` mewajibkan GNOME HIG untuk semua antarmuka, frontend Electron bertentangan dengan aturan proyek sendiri. Ini harus diputuskan sebelum tahap 4.

Risiko pertama, perintah editor ditulis dua kali, terlihat seperti ini. Perintah seperti bold, link, heading, list, dan operasi tabel sekarang mencampur logika teks dengan `Gtk.TextBuffer`. CodeMirror tidak bisa memakai kode itu.

![Perintah editor: sekarang vs setelah logika teks dipisah](electron/perintah-editor.png)

Kalau logikanya dipisah menjadi fungsi murni (teks dan seleksi masuk, edit dan posisi kursor keluar), GTK dan CodeMirror cukup menyediakan adaptor tipis. Fungsi murni itu bisa diuji di Node seperti core lainnya.

## Celah yang belum tercatat (audit 17 Oktober 2026)

Audit seluruh codebase menemukan celah yang belum masuk tahapan di atas. Sebagian besar juga berguna untuk frontend GTK dan bisa diuji di Node, jadi bisa dikerjakan sebelum protokol.

| Celah | Di mana | Yang dibutuhkan |
| --- | --- | --- |
| Peluncuran terminal khusus GNOME ada di core | `src/app/harnessreview.ts` (`kgx`, `ptyxis`, `gnome-terminal`, `xdg-terminal-exec`) | Layanan frontend atau platform, misalnya `openTerminal(folder, command?)`; di macOS dan Windows tidak ada satu pun yang ketemu |
| `fileUri()` mengasumsikan path POSIX | `src/files.ts` | URI `file:///C:/…` untuk path Windows, lewat port atau fungsi yang sadar huruf drive |
| Pengecekan path absolut memakai `startsWith('/')` | `src/agent/harness.ts`, `src/app/harness.ts`, `src/agent/worktree.ts` | `platform().paths.isAbsolute`; sisanya (±59 tempat `split('/')` atau `'/'` di core) diaudit, karena path relatif repo dan git memang benar memakai `/` |
| Logika highlighter terikat GTK | `src/editor/highlighter.ts` (markers, spans, headings, gambar, blok kode, tabel, langsung lewat `Gtk.TextIter`) | Pisahkan parse menjadi fungsi murni (teks masuk, spans dan markers keluar), seperti `editcommands.ts`; tanpa itu CodeMirror menulis ulang highlight dan perilaku menyembunyikan sintaks |
| Rendering inline hanya ke Pango markup | `src/markdown/pango.ts`, `src/markdown/chatmarkup.ts` (kartu kanban, inbox, tabel, chat) | Padanan HTML yang aman untuk renderer; `src/markdown/html.ts` saat ini hanya untuk ekspor |
| Katalog `.mo` dan schema GSettings hanya dibangun meson | `po/`, `data/com.ekaput.Markwork.gschema.xml` | Langkah build sendiri untuk Electron (`po/LINGUAS` masih kosong, jadi belum mendesak) |
| `markworkd` hanya untuk Linux | `markworkd/contrib/` (systemd, Docker); `runtimeDir` jatuh ke `~/.cache` tanpa XDG | Cara menjalankan daemon dan jalur socket di macOS dan Windows |
| Belum ada CI | tidak ada `.github/` | `npm run test:core:node` di Linux, macOS, dan Windows (syarat tahap 3) |
| Dependensi Electron belum ada | `package.json` | `electron`, CodeMirror 6, framework UI renderer, dan electron-builder atau Forge |

Urutan yang disarankan: pisahkan parse highlighter dan rapikan path di core lebih dulu, lalu protokol tahap 1 (`messages.ts`, `replica.ts`, tes fuzz), lalu irisan board dari ujung ke ujung.
