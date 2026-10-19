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
| Jendela | Keyboard Shortcuts, About | `FrontendCommands` | ✅ | — |
| Jendela | Tema terang/gelap, setting `dark` | setting `color-scheme` | ✅ | — |
| Sidebar | Files: pohon, buat, ganti nama, hapus, pindah, drop dari luar (`filetree.ts`) | `FileTreeView`, `FilesDialogs` | ✅ | — |
| Sidebar | Search di semua catatan, replace all (`searchpanel.ts`) | `SearchView`, `SearchDialogs` | ✅ | — |
| Sidebar | Outline (`outline.ts`) | `OutlineView` | ✅ | — |
| Halaman | Home (`home.ts`) | `ViewScreen.showHome`, `HomeData` | 🟡 semua kecuali Add to Journal (Fase 4) | 4 |
| Halaman | Tab HTML dengan sandbox (`htmlpage.ts`) | `showPageTab`, `markdown/htmlview.ts` | ✅ | — |
| Dialog | Preferences umum (`preferences.ts`) | `PreferencesView` | ✅ umum dan Assistant; halaman Agents di Fase 6 | 6 |
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
**Status (19 Oktober 2026):** dimulai. Selesai: hanging indent, klik checkbox, Ctrl+klik link, wikilink (`ask.notes`, `open.note` di `handlers/notes.ts`, saran `[[` dengan `@codemirror/autocomplete`), gambar inline (`electron/renderer/images.ts`, skema `app://` di `main.ts`) dan zoom (`view.image`, `ImageViewer.tsx`), warna blok kode (`codecolor.ts`, `@codemirror/language-data` dimuat per bahasa), tabel sebagai grid (`tables.ts`; klik sel membuka teks mentah di sel itu, seperti GTK), Mermaid dan DBML (`diagrams.ts`; `mermaid.min.js` disalin saat build dan dimuat saat diagram pertama tampil), konflik git (`conflicts.ts`, tombol Accept Current/Incoming/Both), focus dan typewriter (setting inti, digambar editor), dan quit (`app.close` → `closeRequest()`, main menahan `close` sampai halaman melepas); dicakup `tests/electron-smoke.mjs` dan `tests/unit/protocol.ts`. Blok kode juga box yang digulir menyamping (`CodeBoxWidget`). Paritas Enter/Tab diuji (menemukan dan memperbaiki Enter di blok kode, seleksi, Shift+Enter) dan pertanyaan terbuka undo ditutup (`protocol.md` 16). Sisa Fase 1: padanan Playwright untuk skenario `tests/gui` yang belum ada (`format`, `syntax`, `imagezoom` dst.), dan tes asap wikilink yang kadang flaky.

Editor adalah alasan utama aplikasi ini ada, jadi editor didahulukan. Hampir semua pekerjaan di fase ini ada di renderer (`electron/renderer/editor.ts`), karena logikanya sudah murni.

| Fitur | Rujukan GTK | Cara di CodeMirror | Butuh pesan baru |
| --- | --- | --- | --- |
| Enter/Tab di list, quote, tabel | `editor/lists.ts`, `tableedit.ts` | keymap ke `editcommands.ts`; cek paritas dengan `tests/gui/lists.ts`, `table.ts` | — |
| Klik checkbox, Ctrl+klik link | `editor/clicks.ts` | `EditorView.domEventHandlers`; link luar lewat `open.uri` | — |
| Wikilink: buka target, saran `[[` | `clicks.ts`, `wikicomplete.ts`, `app/notes.ts` | `@codemirror/autocomplete` dengan cache jawaban `ask.notes`; klik mengirim `open.note` | `ask.notes`, `open.note` |
| Gambar inline | `editor/images.ts` | block widget di baris tidak aktif; path dibaca lewat protokol `app://` milik main | — |
| Zoom gambar | `ui/imageviewer.ts` | dialog di jendela utama | `view.image` (`showImage`) |
| Blok kode | `codehighlight.ts`, `codelayer.ts` | `@codemirror/language` + `language-data` untuk bahasa di dalam fence; box yang bisa digulir menyamping | — |
| Tabel sebagai grid | `tablelayer.ts` | block widget yang dibangun dari `markdown/table.ts`; edit sel menjadi transaksi | — |
| Mermaid, DBML | `mermaid.ts`, `mermaidrender.ts` | `mermaid` (sudah di devDependencies) dirender di renderer; DBML diterjemahkan dengan `markdown/dbml.ts` | — |
| Konflik git | `conflictlayer.ts`, `conflicts.ts` | dekorasi warna + baris tombol, logika dari `conflicts.ts` | — |
| Hanging indent | `listindent.ts` | line decoration dengan `text-indent` negatif | — |
| Focus, typewriter, source | `editor/view.ts`, `decorations.ts` | dekorasi redup + scroll ke tengah; source sudah ada | setting (Fase 0) |
| Quit / tutup jendela | `window.ts` | `before-unload` di main → `ask.saveChanges` per dokumen | `app.quit` |

Selesai bila: setiap skenario editor di `tests/gui/` (`format`, `lists`, `table`, `wikilink`, `image`, `imagezoom`, `codeblock`, `codecolor`, `syntax`, `mermaid`, `conflicts`) punya padanan Playwright di Electron, atau tes protokol bila perilakunya ada di core.

Pertanyaan terbuka dari `protocol.md` 16 (undo melintasi tulisan core, interval penggabungan) diukur dan ditutup di fase ini.

### Fase 2 — Kerangka jendela dan sidebar (L)

**Status (19 Oktober 2026):** dimulai. Selesai: menu utama (Commands, Find, Export, Home, Journal, Dark Mode, Preferences, Shortcuts, About, Quit; menu New dengan Open dan Recent lewat notice `recent`), dialog Preferences (`view.prefs.open/values`, `act.prefs.set/closed`; halaman General dan Assistant), Keyboard Shortcuts dan About; tab halaman (`page.open/close/active`, `view.home`, `act.home.*`; Home dan tab HTML lewat skema `mwhtml://` di `main.ts` dengan CSP dan `will-frame-navigate`; tombol Add to Journal menunggu Fase 4, HTML belum memuat ulang otomatis saat file berubah), pohon Files penuh (`view.tree.root/folder/expand/reveal`, `act.tree.openFolder/activate/create/rename/remove/move/copy`, `ask.files.name`, `ask.files.confirm`; folder dibuka malas, menu konteks, F2/Delete, seret ke folder; drop dari file manager lewat `webUtils.getPathForFile` belum diuji otomatis), panel Search (`view.search`, `act.search.run/openHit/replaceAll`, `ask.search.confirm`; `doc.select` menandai hit; Ctrl+Shift+F/H) dan rail tiga halaman (Files, Search, Outline; setting `sidebar-page`) dan panel Outline (`view.outline` dari `ProtocolOutline`, `act.outline.jump`; replika melapor perubahan judul ke sesi lewat `onHeadings`). Fase 2 selesai kecuali yang menunggu fase lain (Add to Journal, halaman Agents, tab History dan Pull requests di rail) dan tes asap untuk drop dari file manager. Berikutnya: Fase 3 (view terstruktur).

| Fitur | Pesan | Komponen |
| --- | --- | --- |
| Files penuh | `view.tree.root`, `view.tree.folder`, `view.tree.expand`, `view.tree.reveal`; `act.tree.open`, `.activate`, `.create`, `.rename`, `.remove`, `.move`, `.copy`; ask `files.name`, `files.confirm` | `Explorer.tsx` diganti pohon malas (folder dibuka saat dibutuhkan), menu konteks, drag di dalam pohon, drop dari file manager (path diambil di preload lewat `webUtils.getPathForFile`) |
| Search di semua catatan | `view.search`; `act.search.run`, `.openHit`, `.replaceAll`; ask `search.confirm` | panel Search; `Ctrl+Shift+F` / `Ctrl+Shift+H` |
| Outline | `view.outline`; `act.outline.jump` | panel Outline |
| Rail ikon | setting `sidebar-page` | rail dengan Files, Search, Outline, History, Pull requests (dua yang terakhir aktif di Fase 5) |
| Home | `view.home` (`HomeData`) | halaman Home; aksi kartu memakai `act.notes.edit` / `open.file` |
| Tab HTML | `view.page` `html` + isi dari `markdown/htmlview.ts` | `<iframe sandbox>` dengan CSP; tautan dan jaringan dicegat dan dikonfirmasi lewat `will-navigate` di main (aturan sama dengan WebKitGTK) |
| Menu utama dan Recent | `setRecent` | popover menu header bar (sudah ada kerangkanya) |
| Preferences umum | `view.prefs.open`, `.values`; `act.prefs.set` | dialog Preferences: tab Umum, Editor, Assistant (halaman Agent menyusul di Fase 6) |
| Keyboard Shortcuts, About | — (`runs: 'editor'`) | dua dialog, dibangun dari `COMMANDS` |

Selesai bila: `tests/gui/folder*.ts`, `file.ts`, `tabs.ts`, `home.ts`, `htmlpage.ts`, `window.ts`, `dialogs.ts` punya padanan.

### Fase 3 — View terstruktur (L)

Semua view memakai `view.notes` + `act.notes.edit` yang sudah ada. Pekerjaannya kebanyakan di renderer.

1. **Board penuh**: tambah/ubah/hapus kolom, pindah kolom, edit kartu, `groupField`, popover field (select, tanggal, teks dengan validasi dari `markdown/fields.ts`), `view.focusCapture`. Rujukan: `ui/kanban.ts`, `fieldpopover.ts`, `tests/gui/kanban*.ts`.
2. **List/inbox** dengan capture dan section (`ui/inbox.ts`).
3. **Table** (`ui/table.ts`, `markdown/tablelayout.ts`).
4. **Calendar, timeline, gallery, chart** (`ui/calendar.ts`, `timeline.ts`, `gallery.ts`, `chart.ts`). Modelnya sudah di `markdown/*.ts`. Chart cukup SVG di React tanpa pustaka chart.
5. **Dialog Fields…**: `ask.schema {fields, reserved, uses}` (`protocol.md` 7).
6. **Tab CSV**: grid yang bisa diedit, dengan find bar sendiri. Butuh `view.csv` dan `act.csv.change` / `.shape` (`CsvPage.onChange`, `onShape`).
7. **Menu layout dan perintah `*-new`**: `command layout <arg>`, `inbox-new`, `table-new`, `csv-new`.

Selesai bila: `tests/gui/kanban*.ts`, `inbox.ts`, `layouts.ts`, `tablelayout.ts`, `csv*.ts` punya padanan, dan undo langkah kartu berperilaku sama dengan GTK.

### Fase 4 — Journal dan Assistant (L)

- **Journal**: `ask.capture`, ditambah perintah `journal`, `journal-capture`, dan `journal-summary` (cukup menjalankan perintah core). **S**.
- **Panel Assistant**: notice `chat.*` dan aksi `act.chat.*` sesuai `protocol.md` 6.5. Jawaban asisten digambar dengan `markdown/chatblocks.ts` + `chathtml.ts`, yang sudah menghasilkan HTML aman. Kartu status turn, daftar kerja, tombol Insert/Undo.
- **Popover** konteks (`act.chat.preview`, `.options`), riwayat (`.chats`, `.open`, `.delete`), dan pengaturan (`.model`, `.thinking`, `.save`, `.key`).
- **Proposal**: `ask.proposal` dengan diff, `act.proposal.apply` untuk sebagian batch, dan `ask.cancel` saat turn dihentikan. Aturan agent tidak berubah: hanya core yang menulis, dan `applyChange()` memeriksa ulang teks.
- **Log agent**: `chat.log` membawa `TraceUpdate`. Renderer memegang `TraceReplica` (`agent/tracetree.ts` sudah murni) dan menggambar pohon dan detail.

Selesai bila: `tests/gui/chat.ts`, `context.ts`, `journal.ts` punya padanan, dan `tests/unit/assistant.ts` dijalankan juga lewat protokol.

### Fase 5 — Git dan kolaborasi (L)

- **History**: `view.history`, `view.historyChanges`, `history.messageText`, dan aksi `act.history.*` (`protocol.md` 6.5). Kotak pesan commit dengan tombol sparkle (pesan ditulis streaming oleh core).
- **History viewer**: `view.historyViewer.*` sebagai dialog besar di jendela utama, dengan tab Changes dan Contents; `ask.discard`.
- **Collab**: `view.collab`; `act.collab.*`; `ask.token` dengan tombol Test (`act.collab.testToken`).
- **Review pull request**: `view.pull` dan `act.pull.*` sebagai halaman di area konten (`showPull`); `ask.pull.merge` dan sejenisnya.
- **Kirim perubahan**: `ask.sendChanges` (form `SendChangesOptions`).
- Komponen diff dibuat sekali (`DiffLine[]`) dan dipakai ulang oleh history, pull request, proposal, dan review worktree.

Selesai bila: `tests/gui/history.ts`, `collab.ts`, `forgejo.ts` punya padanan; `npm run test:forgejo` dijalankan juga terhadap Electron.

### Fase 6 — Agent dan harness (L)

- **Menu kartu**: `ask.menu {at, entries}` → token (`protocol.md` 6.4). Status run masuk ke kartu lewat `view.notes`.
- **Log run**: `view.runlog` dengan `TraceUpdate`, `act.runlog.clear` dan `.closed`. Viewer log Fase 4 dipakai ulang.
- **Dialog harness**: `ask.folder`, `ask.harness.answer`, `ask.text`, `ask.remoteFolder`, `ask.closeAgents` (juga dipanggil saat jendela ditutup).
- **Review worktree**: `view.review` + `act.review.*`, `ask.review.merge`/`discard`, `ask.pullRequest`. Tombol Terminal memakai `platform().processes.openTerminal`, atau terminal bawaan Electron nanti.
- **Preferences → Agents**: mesin (`ask.machine`), proyek, isolasi, worktree (`ask.removeWorktree`).
- **Status `markworkd`** di Home dan Preferences (`agentHost()`). Di macOS dan Windows daemon belum ada (`electron.md`, status celah), jadi agent berjalan sebagai proses anak dan UI menyembunyikan pilihan daemon lokal.

Selesai bila: `tests/gui/harness.ts`, `agentshost.ts` punya padanan, dan `tests/unit/daemon-fake.ts` dijalankan dengan frontend protokol.

### Fase 7 — Platform dan rilis (M–L)

- `Secrets` di macOS dan Windows lewat `safeStorage`, diteruskan dari main ke core (`electron.md` tahap 3).
- Bundel `.mo` dan schema untuk i18n (`po/`), di `scripts/electron-build.mjs`.
- Packaging dengan electron-builder (AppImage/deb, dmg, nsis), update otomatis, tanda tangan kode di Windows, notarisasi di macOS.
- CI tiga OS: `npm run test:core:node`, tes protokol, dan tes asap Electron.
- Keputusan multi-jendela: satu utility process per jendela, atau tetap satu jendela.

## Urutan dan ketergantungan

```
Fase 0 ──┬─> Fase 1 (editor)
         ├─> Fase 2 (kerangka) ──┬─> Fase 5 (git, kolaborasi)
         │                       └─> Fase 6 (agent) <── Fase 4 (log viewer)
         ├─> Fase 3 (view terstruktur) ─> Fase 6 (menu kartu)
         └─> Fase 4 (assistant)
Fase 7 bisa mulai kapan saja, tetapi harus selesai sebelum rilis di luar Linux.
```

Fase 1, 2, 3, dan 4 bisa berjalan paralel setelah Fase 0, asalkan tiap PR hanya menyentuh `frontend.ts`/`server.ts` di bagian fiturnya sendiri. Supaya tidak bentrok, pecah handler server per controller (misalnya `src/app/protocol/handlers/<fitur>.ts`) sebagai langkah pertama Fase 0.

**Titik "bisa dipakai sehari-hari"** ada setelah Fase 0–3: editor Markdown lengkap dengan Files, Search, Outline, Home, dan semua layout. Fase 4–6 membawa fitur khas Markwork (Assistant, git, agent).

## Risiko

- **Perilaku editor yang halus.** Hal seperti penyembunyian sintaks, hanging indent, dan undo dari tulisan core mudah berbeda sedikit dari GTK. Mitigasinya adalah skenario Playwright yang meniru `tests/gui/` satu per satu, bukan pemeriksaan manual.
- **Widget blok di CodeMirror** (tabel, gambar, mermaid) memengaruhi pengukuran tinggi baris dan scroll. Mulai dari tabel, yang paling sering dipakai, lalu ukur di dokumen besar (`bench/tables-500.json`).
- **Server protokol membengkak.** Tanpa pemecahan per controller, `server.ts` dan `frontend.ts` akan menjadi file ribuan baris. Pecah di Fase 0.
- **Logika bocor ke renderer.** Godaan terbesar ada di board dan Assistant. Aturannya: kalau GTK dan Electron butuh perhitungan yang sama, perhitungan itu tempatnya di `src/markdown/` atau `src/app/`. `scripts/layers.mjs` sudah memeriksa `electron/renderer` (dari `src/` hanya `markdown/`, `app/protocol/` messages, wire, mirror, changes, `app/commands.ts`, dan tipe dari `screen.ts`, `dialogs.ts`, `platform/index.ts`).
- **Strategi produk.** Memori proyek mencatat "GNOME dulu; Electron kontingensi". Rencana ini menganggap keputusan 19 Oktober 2026 (Electron dibangun aktif) berlaku. Kalau prioritas kembali ke GTK, Fase 0 tetap berguna dan fase lain bisa berhenti di batas fase mana pun tanpa meninggalkan fitur setengah jadi.
