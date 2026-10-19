# Rencana migrasi fitur GTK ke Electron

19 Oktober 2026 · Eka Putra · lanjutan dari [`electron.md`](electron.md) (arsitektur) dan [`protocol.md`](protocol.md) (pesan)

## Ringkasan

Fondasi Electron sudah jalan: protokol (`src/app/protocol/`), utility process yang menjalankan `AppSession` asli, dan renderer React dengan CodeMirror 6 yang meniru jendela GTK. Yang sudah tersambung baru irisan tipis: folder dan daftar file, tab dokumen, editor teks dengan highlight dan perintah bersama, find/replace di dokumen, board dasar, toast, `ask.saveChanges`, dan `ask.file` untuk folder.

Semua anggota `AppFrontend` lain masih `unwired` (`src/app/protocol/unwired.ts`): dipanggil tidak terjadi apa-apa, ditanya dianggap "tidak". **Migrasi selesai ketika `unwired()` tidak lagi menangkap satu anggota pun**, dan setiap fitur di tabel inventaris di bawah lulus skenario yang sama dengan GTK.

Karena keputusan aplikasi sudah ada di `src/app/`, pekerjaan per fitur hampir selalu tiga hal yang sama:

1. **Pesan.** Tambahkan notice `view.*`, aksi `act.*`, dan ask `ask.*` di `frontend.ts`/`server.ts`, mengikuti tabel 6.5 dan 7 di `protocol.md`.
2. **Komponen.** Buat komponen React yang hanya menggambar snapshot dan mengirim aksi. Tidak ada logika aplikasi di renderer.
3. **Skenario.** Tulis tes yang menjalankan `AppSession` asli lewat protokol di Node (seperti `tests/unit/protocol.ts`), dan skenario yang sama terhadap GTK bila perilakunya bisa berbeda.

Urutan yang disarankan ada di bagian [Fase](#fase). Fase 0 adalah infrastruktur protokol bersama yang dibutuhkan hampir semua fitur. Setelah itu, editor, kerangka jendela, dan view terstruktur adalah inti editor Markdown. Assistant, git, kolaborasi, dan agent menyusul.

## Prinsip

- **GTK adalah rujukan.** Perilaku diambil dari frontend GTK dan tesnya di `tests/gui/`. Tampilan mengikuti jendela GTK (warna Adwaita, ikon simbolis, header bar), tetapi aturan GNOME HIG tidak berlaku untuk `electron/`.
- **Renderer hanya menggambar.** Logika teks ada di `src/markdown/`, keputusan ada di `src/app/`. Kalau sebuah komponen React mulai memutuskan sesuatu, logika itu dipindah ke core dulu, lalu dipakai oleh kedua frontend.
- **Satu fitur, satu PR.** Setiap PR mengeluarkan anggota dari `unwired`, menambah pesan, komponen, dan tes. Daftar `unwired` hanya boleh menyusut.
- **Snapshot dulu, patch kalau perlu.** Sesuai `protocol.md` 6.1: view mengirim snapshot utuh. Patch baru dibuat kalau pengukuran menunjukkan view terlalu besar (log agent dan stream chat sudah inkremental dari awal).
- **Jendela kedua menjadi panel atau dialog di jendela yang sama.** GTK membuka jendela terpisah untuk log agent, history viewer, proposal viewer, dan image viewer. Di Electron versi pertama, semuanya menjadi dialog atau halaman di jendela utama, karena satu core melayani satu jendela (`electron.md`, risiko "Satu jendela per core"). `BrowserWindow` tambahan bisa menyusul tanpa mengubah protokol.

## Inventaris fitur

Status: ✅ ada di Electron · 🟡 sebagian · ⬜ belum.

| Area | Fitur GTK (modul) | Controller / interface | Electron | Fase |
| --- | --- | --- | --- | --- |
| Dokumen | Tab, buka, tutup, simpan, autosave | `DocumentController`, `FrontendDocuments` | ✅ | — |
| Dokumen | Simpan Sebagai, Buka File, Export HTML, Recent | `DocumentDialogs.chooseFile`, `setRecent` | 🟡 tanpa Recent | 0 |
| Dokumen | Tutup aplikasi dengan perubahan belum disimpan | `ask.saveChanges` saat quit | ✅ | — |
| Editor | Highlight, sembunyi sintaks, perintah format | `markdown/highlight.ts`, `editcommands.ts` | ✅ | — |
| Editor | Find/replace dalam dokumen | panel CodeMirror | ✅ | — |
| Editor | Enter/Tab di list, quote, tabel (`lists.ts`, `tableedit.ts`) | `editcommands.ts` | ✅ | — |
| Editor | Klik checkbox, Ctrl+klik link dan wikilink (`clicks.ts`) | `NoteLinks`, `markdown/clicks.ts` (murni) | ✅ | — |
| Editor | Saran `[[` (`wikicomplete.ts`) | `ask.notes` | ✅ | — |
| Editor | Gambar inline, zoom gambar (`images.ts`, `imageviewer.ts`) | `showImage`, `markdown/imagesource.ts` (murni) | ✅ | — |
| Editor | Blok kode berwarna (`codehighlight.ts`, `codelayer.ts`) | — (renderer) | ✅ | — |
| Editor | Tabel sebagai grid (`tablelayer.ts`) | `markdown/table.ts` (termasuk `fitColumns`) | ✅ | — |
| Editor | Mermaid dan DBML (`mermaid.ts`, `mermaidrender.ts`) | `markdown/dbml.ts`, `markdown/diagram.ts` | ✅ | — |
| Editor | Penanda konflik git (`conflictlayer.ts`) | `markdown/conflicts.ts` (murni) | ✅ | — |
| Editor | Hanging indent list (`listindent.ts`) | — | ✅ | — |
| Editor | Mode source, focus, typewriter | `ViewOption`, setting | ✅ | — |
| Jendela | Header bar, menu utama, tombol layout | `ViewScreen.showLayout`, `enableActions` | 🟡 tombol layout dan status perintah ada; menu layout belum | 2 |
| Jendela | Command palette | `COMMANDS` | ✅ | — |
| Jendela | Status: kata, board, inbox, CSV (`statusbar.ts`) | `ViewScreen.setCounts…` | ✅ | — |
| Jendela | Keyboard Shortcuts, About | `FrontendCommands` | ⬜ | 2 |
| Jendela | Tema terang/gelap, setting `dark` | setting `color-scheme` | ✅ | — |
| Sidebar | Files: pohon, buat, ganti nama, hapus, pindah, drop dari luar (`filetree.ts`) | `FileTreeView`, `FilesDialogs` | 🟡 pohon baca saja dari `view.files` | 2 |
| Sidebar | Search di semua catatan, replace all (`searchpanel.ts`) | `SearchView`, `SearchDialogs` | ⬜ | 2 |
| Sidebar | Outline (`outline.ts`) | `OutlineView` | ⬜ | 2 |
| Halaman | Home (`home.ts`) | `ViewScreen.showHome`, `HomeData` | ⬜ | 2 |
| Halaman | Tab HTML dengan sandbox (`htmlpage.ts`) | `showPageTab`, `markdown/htmlview.ts` | ⬜ | 2 |
| Dialog | Preferences umum (`preferences.ts`) | `PreferencesView` | ⬜ | 2 |
| Struktur | Board penuh: kolom, grup per field, popover field (`kanban.ts`, `fieldpopover.ts`) | `KanbanView`, `NoteEdit` | 🟡 pindah, centang, tambah | 3 |
| Struktur | List/inbox dengan capture (`inbox.ts`) | `CaptureView` | ⬜ | 3 |
| Struktur | Table (`table.ts`) | `CaptureView` | ⬜ | 3 |
| Struktur | Calendar, timeline, gallery, chart | `layouts: NotesView` | ⬜ | 3 |
| Struktur | Dialog Fields… (`schemadialog.ts`) | `ViewDialogs.editSchema` | ⬜ | 3 |
| Struktur | Tab CSV dengan find bar (`csvpage.ts`, `csvfindbar.ts`) | `CsvPage` | ⬜ | 3 |
| Struktur | Dokumen baru: board, inbox, table, CSV | `COMMANDS` `*-new` | 🟡 board saja | 3 |
| Journal | Jurnal hari ini, Add to Journal, ringkasan | `JournalController`, `JournalDialogs.capture` | ⬜ | 4 |
| Assistant | Panel chat streaming (`chat.ts`, `chatturn.ts`, `worklist.ts`) | `ChatPanelView` | ⬜ | 4 |
| Assistant | Popover konteks, riwayat, pengaturan + API key | `onPreview`, `onChats`, `onSaveKey` | ⬜ | 4 |
| Assistant | Proposal dan review perubahan (`proposalcard.ts`, `proposalviewer.ts`) | `review` → `ask.proposal` | ⬜ | 4 |
| Assistant | Log agent (`logviewer.ts`, `logdetail.ts`) | `logUpdate`, `TraceReplica` | ⬜ | 4 |
| Git | Tab History, commit, discard, pesan commit dari AI (`history.ts`, `messagebox.ts`, `messagewriter.ts`) | `HistoryTabView`, `HistoryDialogs` | ⬜ | 5 |
| Git | History viewer per commit (`historyviewer.ts`) | `HistoryViewersView` | ⬜ | 5 |
| Kolaborasi | Tab pull request, token server (`collab.ts`, `serverdialog.ts`) | `CollabView`, `CollabDialogs` | ⬜ | 5 |
| Kolaborasi | Halaman review pull request (`pullview.ts`) | `PullReviewView`, `PullDialogs` | ⬜ | 5 |
| Kolaborasi | Kirim perubahan sebagai PR (`sendchanges.ts`) | `ContributeDialogs.send` | ⬜ | 5 |
| Agent | Menu kartu, status run di board | `HarnessBoard` → `ask.menu` | ⬜ | 6 |
| Agent | Jendela log run (`window/harnesslogs.ts`) | `HarnessLogs` | ⬜ | 6 |
| Agent | Dialog harness: jawab, teks, folder, folder remote, tutup agent | `HarnessDialogs` | ⬜ | 6 |
| Agent | Review worktree kartu, dialog PR (`harnessreview.ts`, `pullrequestdialog.ts`) | `ReviewView`, `ReviewDialogs` | ⬜ | 6 |
| Agent | Preferences: mesin, proyek, worktree (`projectsettings.ts`) | `PreferencesView`, `PreferencesDialogs` | ⬜ | 6 |
| Platform | Notifikasi desktop, buka terminal, buka folder | `notify`, `openTerminal`, `openFolder` | ⬜ | 0 / 6 |
| Platform | Kunci API di macOS/Windows | `Secrets` → `safeStorage` | ⬜ | 7 |
| Rilis | i18n `.mo`, packaging, update otomatis, CI 3 OS | — | ⬜ | 7 |

## Fase

Perkiraan ukuran: **S** ≤ 1 hari, **M** 2–4 hari, **L** 1–2 minggu, untuk satu orang dengan bantuan agent.

### Fase 0 — Infrastruktur protokol bersama (M)

**Status (19 Oktober 2026):** selesai, kecuali CI (belum ada CI sama sekali).

- Handler per controller (`src/app/protocol/handlers/`), `Asks` dan `ask.cancel`.
- Dialog generik di renderer (`electron/renderer/Dialog.tsx`), yang menjawab setiap `Question`/`Prompt` lewat `Connection.onOther`.
- `ask.file` lengkap (Open, Save As, Export HTML, Insert Image).
- `hello` dengan tabel perintah dan setting, notice `setting` dua arah, dan tema yang mengikuti `color-scheme`.
- `ProtocolScreen` (`view.status`, `view.layout`, `commands.state`, `find.close`) serta layanan `notify` dan `reveal.folder`.
- Tulisan board/list lewat `update()`.
- Guard `STILL_UNWIRED` di `tests/unit/protocol.ts`, saat ini 29 anggota.
- Tes asap Playwright: `npm run test:electron` (`tests/electron-smoke.mjs`).

Bagian ini dibutuhkan oleh hampir semua fitur. Mengerjakannya sekali di awal mencegah setiap PR fitur membuat jalan pintas sendiri.

- **`hello` membawa tabel perintah dan semua setting** (`protocol.md` 8 dan 9.2). Tambahkan notice `setting` dua arah. Renderer berhenti mengimpor `COMMANDS` langsung untuk *state*; tabel tetap boleh diimpor untuk label dan tombol.
- **`commands.state`** dari `ViewScreen.enableActions`, supaya menu dan palette menonaktifkan perintah yang sama dengan GTK.
- **`view.status`** (`setCounts`, `setBoardCounts`, `setInboxCounts`, `setCsvCounts`, `setStatusVisible`) dan **`view.layout`** (`showLayout`, `setStructuredState`). Hitungan kata pindah dari renderer ke core, seperti di GTK.
- **Helper ask generik di server dan client.** Satu fungsi `ask(op, payload, parse)` di `frontend.ts`, satu registri handler `ask.*` di `client.ts`, dan **`ask.cancel`** (`protocol.md` 7). Di renderer: satu komponen dialog generik (judul, teks, tombol, field) untuk `Question` dan `Prompt` dari `app/dialogs.ts`. Banyak ask cukup memakai komponen ini.
- **`ask.file` lengkap**: buka file, simpan sebagai, filter, nama awal. Main process menjawab dengan `dialog.showOpenDialog` / `showSaveDialog`. Ini sekaligus menyelesaikan Open File, Save As, Insert Image, dan Export HTML.
- **Layanan frontend** (`protocol.md` 9.1): `notify` lewat `Notification`, `openFolder` lewat `shell.openPath`, `setRecent`, dan `toast` dengan tombol (sudah ada) diuji untuk token yang `stale`.
- **Tema**: setting `dark` / `color-scheme` mengubah `data-theme` di renderer, tidak hanya mengikuti sistem.
- **Board yang bertahan saat mengetik**: `ViewController.writeBoard` lewat `update()`, bukan tulisan utuh (tercatat sebagai *Next* di `protocol.md`).
- **Tes**:
  - Tambah guard yang menghitung anggota yang masih `unwired` (misalnya `tests/unit/protocol.ts` mencatat setiap akses ke `nothing()`), lalu cetak angkanya. Angka ini menjadi ukuran kemajuan migrasi.
  - Tes asap Electron: Playwright `_electron` menjalankan `npm run electron -- tests/samples`, membuka satu file, mengetik, lalu menyimpan. Jalankan di CI Linux dengan `xvfb-run`.

Selesai bila: semua ask dan notice di atas punya tes protokol, dan tes asap Electron jalan di CI.

### Fase 1 — Paritas editor (L)

**Status (19 Oktober 2026):** dimulai. Selesai: hanging indent, klik checkbox, Ctrl+klik link, wikilink (`ask.notes`, `open.note` di `handlers/notes.ts`, saran `[[` dengan `@codemirror/autocomplete`), gambar inline (`electron/renderer/images.ts`, skema `app://` di `main.ts`) dan zoom (`view.image`, `ImageViewer.tsx`), warna blok kode (`codecolor.ts`, `@codemirror/language-data` dimuat per bahasa), tabel sebagai grid (`tables.ts`; klik sel membuka teks mentah di sel itu, seperti GTK), Mermaid dan DBML (`diagrams.ts`; `mermaid.min.js` disalin saat build dan dimuat saat diagram pertama tampil), konflik git (`conflicts.ts`, tombol Accept Current/Incoming/Both), focus dan typewriter (setting inti, digambar editor), dan quit (`app.close` → `closeRequest()`, main menahan `close` sampai halaman melepas); dicakup `tests/electron-smoke.mjs` dan `tests/unit/protocol.ts`. Blok kode juga box yang digulir menyamping (`CodeBoxWidget`). Paritas Enter/Tab diuji (menemukan dan memperbaiki Enter di blok kode, seleksi, Shift+Enter) dan pertanyaan terbuka undo ditutup (`protocol.md` 16). `tests/electron-editor.mjs` memberi padanan Playwright untuk `format`, `syntax`, `wikilink`, `image`, `imagezoom`, `codeblock`, `codecolor`, dan `conflicts` (`lists`, `table`, dan Mermaid ada di `electron-smoke.mjs`). Yang ditemukan dan ditutup: lompat ke section `[[note#heading]]` (`doc.reveal`), Ctrl+klik link relatif `.md` (`open.link`), gambar tersembunyi di mode source, Tab menerima saran `[[`, widget blok ikut redup di focus mode, penampil gambar dengan zoom, geser, dan fit. **Fase 1 selesai**, kecuali CI (belum ada).s` (`lists` dan `table` ada di `electron-smoke.mjs`; `mermaid` di sana juga). Menemukan dan menutup: lompat ke section `[[note#heading]]` (`doc.reveal`), Ctrl+klik link relatif `.md` (`open.link`), gambar tersembunyi di mode source, Tab menerima saran `[[`, widget blok ikut redup di focus mode, penampil gambar dengan zoom/geser/fit. **Fase 1 selesai** kecuali CI.