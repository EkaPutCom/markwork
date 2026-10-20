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
| Jendela | Header bar, menu utama, tombol layout | `ViewScreen.showLayout`, `enableActions` | ✅ | — |
| Jendela | Command palette | `COMMANDS` | ✅ | — |
| Jendela | Status: kata, board, inbox, CSV (`statusbar.ts`) | `ViewScreen.setCounts…` | ✅ | — |
| Jendela | Keyboard Shortcuts, About | `FrontendCommands` | ✅ | — |
| Jendela | Tema terang/gelap, setting `dark` | setting `color-scheme` | ✅ | — |
| Sidebar | Files: pohon, buat, ganti nama, hapus, pindah, drop dari luar (`filetree.ts`) | `FileTreeView`, `FilesDialogs` | ✅ | — |
| Sidebar | Search di semua catatan, replace all (`searchpanel.ts`) | `SearchView`, `SearchDialogs` | ✅ | — |
| Sidebar | Outline (`outline.ts`) | `OutlineView` | ✅ | — |
| Halaman | Home (`home.ts`) | `ViewScreen.showHome`, `HomeData` | ✅ | — |
| Halaman | Tab HTML dengan sandbox (`htmlpage.ts`) | `showPageTab`, `markdown/htmlview.ts` | ✅ | — |
| Dialog | Preferences umum (`preferences.ts`) | `PreferencesView` | ✅ umum, Assistant, dan Agents | — |
| Struktur | Board penuh: kolom, grup per field, popover field (`kanban.ts`, `fieldpopover.ts`) | `KanbanView`, `NoteEdit` | ✅ | — |
| Struktur | List/inbox dengan capture (`inbox.ts`) | `CaptureView` | ✅ | — |
| Struktur | Table (`table.ts`) | `CaptureView` | ✅ | — |
| Struktur | Calendar, timeline, gallery, chart | `layouts: NotesView` | ✅ | — |
| Struktur | Dialog Fields… (`schemadialog.ts`) | `ViewDialogs.editSchema` | ✅ | — |
| Struktur | Tab CSV dengan find bar (`csvpage.ts`, `csvfindbar.ts`) | `CsvPage` | ✅ | — |
| Struktur | Dokumen baru: board, inbox, table, CSV | `COMMANDS` `*-new` | ✅ | — |
| Journal | Jurnal hari ini, Add to Journal, ringkasan | `JournalController`, `JournalDialogs.capture` | ✅ | — |
| Assistant | Panel chat streaming (`chat.ts`, `chatturn.ts`, `worklist.ts`) | `ChatPanelView` | ✅ | — |
| Assistant | Popover konteks, riwayat, pengaturan + API key | `onPreview`, `onChats`, `onSaveKey` | ✅ | — |
| Assistant | Proposal dan review perubahan (`proposalcard.ts`, `proposalviewer.ts`) | `review` → `ask.proposal` | ✅ | — |
| Assistant | Log agent (`logviewer.ts`, `logdetail.ts`) | `logUpdate`, `TraceReplica` | ✅ | — |
| Git | Tab History, commit, discard, pesan commit dari AI (`history.ts`, `messagebox.ts`, `messagewriter.ts`) | `HistoryTabView`, `HistoryDialogs` | ✅ | — |
| Git | History viewer per commit (`historyviewer.ts`) | `HistoryViewersView` | ✅ | — |
| Kolaborasi | Tab pull request, token server (`collab.ts`, `serverdialog.ts`) | `CollabView`, `CollabDialogs` | ✅ | — |
| Kolaborasi | Halaman review pull request (`pullview.ts`) | `PullReviewView`, `PullDialogs` | ✅ | — |
| Kolaborasi | Kirim perubahan sebagai PR (`sendchanges.ts`) | `ContributeDialogs.send` | ✅ | — |
| Agent | Menu kartu, status run di board | `HarnessBoard` → `ask.menu` | ✅ | — |
| Agent | Jendela log run (`window/harnesslogs.ts`) | `HarnessLogs` | ✅ | — |
| Agent | Dialog harness: jawab, teks, folder, folder remote, tutup agent | `HarnessDialogs` | ✅ | — |
| Agent | Review worktree kartu, dialog PR (`harnessreview.ts`, `pullrequestdialog.ts`) | `ReviewView`, `ReviewDialogs` | ✅ | — |
| Agent | Preferences: mesin, proyek, worktree (`projectsettings.ts`) | `PreferencesView`, `PreferencesDialogs` | ✅ | — |
| Platform | Notifikasi desktop, buka terminal, buka folder | `notify`, `openTerminal`, `openFolder` | ✅ | — |
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

**Status (19 Oktober 2026):** dimulai. Selesai: menu utama (Commands, Find, Export, Home, Journal, Dark Mode, Preferences, Shortcuts, About, Quit; menu New dengan Open dan Recent lewat notice `recent`), dialog Preferences (`view.prefs.open/values`, `act.prefs.set/closed`; halaman General dan Assistant), Keyboard Shortcuts dan About; tab halaman (`page.open/close/active`, `view.home`, `act.home.*`; Home dan tab HTML lewat skema `mwhtml://` di `main.ts` dengan CSP dan `will-frame-navigate`; tombol Add to Journal ditambah di Fase 4, HTML belum memuat ulang otomatis saat file berubah), pohon Files penuh (`view.tree.root/folder/expand/reveal`, `act.tree.openFolder/activate/create/rename/remove/move/copy`, `ask.files.name`, `ask.files.confirm`; folder dibuka malas, menu konteks, F2/Delete, seret ke folder; drop dari file manager lewat `webUtils.getPathForFile` belum diuji otomatis), panel Search (`view.search`, `act.search.run/openHit/replaceAll`, `ask.search.confirm`; `doc.select` menandai hit; Ctrl+Shift+F/H) dan rail tiga halaman (Files, Search, Outline; setting `sidebar-page`) dan panel Outline (`view.outline` dari `ProtocolOutline`, `act.outline.jump`; replika melapor perubahan judul ke sesi lewat `onHeadings`). Fase 2 selesai kecuali yang menunggu fase lain (halaman Agents, tab History dan Pull requests di rail) dan tes asap untuk drop dari file manager. Berikutnya: Fase 3 (view terstruktur).

| Fitur | Pesan | Komponen |
| --- | --- | --- |
| Files penuh | `view.tree.root`, `view.tree.folder`, `view.tree.expand`, `view.tree.reveal`; `act.tree.open`, `.activate`, `.create`, `.rename`, `.remove`, `.move`, `.copy`; ask `files.name`, `files.confirm` | `Explorer.tsx` diganti pohon malas (folder dibuka saat dibutuhkan), menu konteks, drag di dalam pohon, drop dari file manager (path diambil di preload lewat `webUtils.getPathForFile`) |
| Search di semua catatan | `view.search`; `act.search.run`, `.openHit`, `.replaceAll`; ask `search.confirm` | panel Search; `Ctrl+Shift+F` / `Ctrl+Shift+H` |
| Outline | `view.outline`; `act.outline.jump` | panel Outline |
| Rail ikon | setting `sidebar-page` | rail dengan Files, Search, Outline, History, Pull requests (semuanya aktif sejak Fase 5) |
| Home | `view.home` (`HomeData`) | halaman Home; aksi kartu memakai `act.notes.edit` / `open.file` |
| Tab HTML | `view.page` `html` + isi dari `markdown/htmlview.ts` | `<iframe sandbox>` dengan CSP; tautan dan jaringan dicegat dan dikonfirmasi lewat `will-navigate` di main (aturan sama dengan WebKitGTK) |
| Menu utama dan Recent | `setRecent` | popover menu header bar (sudah ada kerangkanya) |
| Preferences umum | `view.prefs.open`, `.values`; `act.prefs.set` | dialog Preferences: tab Umum, Editor, Assistant, Agents |
| Keyboard Shortcuts, About | — (`runs: 'editor'`) | dua dialog, dibangun dari `COMMANDS` |

Selesai bila: `tests/gui/folder*.ts`, `file.ts`, `tabs.ts`, `home.ts`, `htmlpage.ts`, `window.ts`, `dialogs.ts` punya padanan.

### Fase 3 — View terstruktur (L)

**Status (19 Oktober 2026):** selesai. `view.notes` kini membawa nama halaman (`board`, `inbox`, `table`, `calendar`, `timeline`, `gallery`, `chart`) dan `act.notes.edit` diteruskan ke halaman yang terakhir menerima catatan (`ProtocolFrontend.editNotes`). Tab CSV: `view.csv`, `act.csv.change`, `act.csv.shape`; renderer memegang tabelnya (virtual, hanya baris yang tampak) dan mengirim seluruh teks setelah tiap perubahan; core mengabaikan gema tulisan CSV-nya sendiri (`csvWritten`). `view.focusCapture` untuk dokumen List/Table baru, `ask.schema` untuk Fields…, menu layout di header bar. Komponen: `Board`, `Inbox`, `TableView`, `Calendar`, `Timeline`, `Gallery`, `Chart`, `Csv`, `FieldsDialog`, dan bagian bersama di `notes.tsx` (dialog kartu, popover field, menu konteks). Tes: `tests/electron-structured.mjs` (padanan `kanban*`, `inbox`, `layouts`, `tablelayout`, `csv*`) dan sembilan skenario baru di `tests/unit/protocol.ts`; `unwired` menyusut dari 29 ke 17. Belum: status run agent di kartu board (Fase 6).

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

**Status (20 Oktober 2026):** selesai. Journal: `ask.capture` (`dialogs.journal`), tombol Add to Journal di Home, dan perintah `journal`, `journal-capture`, `journal-summary` di menu utama. Assistant: `ProtocolChatPanel` (`src/app/protocol/chat.ts`) mengubah `ChatPanelView` menjadi notice `chat.settings/busy/turn/context/text/reasoning/tool/work/end/noKey/saveFailed/log` dan ask `ask.proposal`; `handlers/chat.ts` menerima `act.chat.sync/send/stop/reset/preview/options/chats/open/delete/undo/insert/model/thinking/save/key/clearLog` dan `act.proposal.apply`. Frontend tidak pernah mengirim `Change` kembali: proposal dikirim sebagai `ProposalChange` (kata-kata, ukuran, baris diff), disebut dengan nomor dari core, dan path percakapan harus yang sudah didaftar core. Kunci API dikirim ke core dan hanya sumbernya yang kembali. Renderer: `chatmodel.ts` (store sendiri, supaya jawaban yang mengalir tidak menggambar ulang jendela), `Chat.tsx` (panel, kartu status, daftar kerja, kartu proposal, review dengan diff dan catatan, popover konteks, riwayat, pengaturan), dan `LogViewer.tsx` (pohon dan detail). Perhitungan yang sama dengan GTK dipindah ke `src/agent/logrows.ts` (`visibleSteps`, `settledNewest`), dan `scripts/layers.mjs` mengizinkan renderer memakai modul log yang murni. Tes: sembilan skenario baru di `tests/unit/protocol.ts` dan satu di `tests/unit/trace.ts`; `tests/electron-assistant.mjs` (model berskrip `tests/electron-model.mjs`, dimuat core lewat `MARKWORK_TEST_MODEL`) memberi padanan `chat`, `context`, `journal`. `unwired` menyusut dari 17 ke 15 (`dialogs.journal`, `host.chatPanel`). Belum: jendela log terpisah per run agent (Fase 6), tombol Terminal di review.

- **Journal**: `ask.capture`, ditambah perintah `journal`, `journal-capture`, dan `journal-summary` (cukup menjalankan perintah core). **S**.
- **Panel Assistant**: notice `chat.*` dan aksi `act.chat.*` sesuai `protocol.md` 6.5. Jawaban asisten digambar dengan `markdown/chatblocks.ts` + `chathtml.ts`, yang sudah menghasilkan HTML aman. Kartu status turn, daftar kerja, tombol Insert/Undo.
- **Popover** konteks (`act.chat.preview`, `.options`), riwayat (`.chats`, `.open`, `.delete`), dan pengaturan (`.model`, `.thinking`, `.save`, `.key`).
- **Proposal**: `ask.proposal` dengan diff, `act.proposal.apply` untuk sebagian batch, dan `ask.cancel` saat turn dihentikan. Aturan agent tidak berubah: hanya core yang menulis, dan `applyChange()` memeriksa ulang teks.
- **Log agent**: `chat.log` membawa `TraceUpdate`. Renderer memegang `TraceReplica` (`agent/tracetree.ts` sudah murni) dan menggambar pohon dan detail.

Selesai bila: `tests/gui/chat.ts`, `context.ts`, `journal.ts` punya padanan, dan `tests/unit/assistant.ts` dijalankan juga lewat protokol. (`assistant.ts` berjalan dengan panel perekam; lewat protokol, ceritanya ada di `tests/unit/protocol.ts`: giliran, proposal, apply, undo, tolak, hentikan.)

### Fase 5 — Git dan kolaborasi (L)

**Status (20 Oktober 2026):** selesai. Core: `src/app/protocol/history.ts` (`ProtocolHistoryTab`, `ProtocolHistoryViewers`, `ProtocolHistoryDialogs`) dan `src/app/protocol/collab.ts` (`ProtocolCollabPanel`, `ProtocolPullView`, `ProtocolPullDialogs`, `ProtocolCollabDialogs`, `ProtocolContributeDialogs`) mengubah view dan dialog GTK menjadi notice `view.history`, `view.historyChanges`, `history.messageText`, `view.historyViewer.*`, `view.collab`, `view.pull`, `view.pull.show` dan ask `ask.discard`, `ask.token`, `ask.pull.merge/local/abort`, `ask.sendChanges`; `handlers/history.ts` dan `handlers/collab.ts` menerima `act.history.*`, `act.historyViewer.*`, `act.collab.*`, `act.pull.*`. Frontend tidak pernah memilih apa yang ditulis: pull request disebut dengan nomor dan harus yang sudah didaftar core (`stale` kalau tidak), file commit harus yang ditampilkan tab, jawaban `ask.sendChanges` dibaca terhadap tawarannya (hanya file dari daftar, cara kirim yang boleh, nama branch yang diterima git), dan tombol Test di dialog token memakai nomor ask (dialog yang sudah tutup dijawab `stale`). Halaman sidebar yang terbuka adalah setting (`sidebar`, `sidebar-page`), jadi core membaca history hanya saat tab History terbuka (`AppSession.sidebarShown`) tanpa pesan tambahan. Notice yang datang berurutan dalam satu giliran (review membuka belasan hal) dikirim sekali dengan nilai terakhir. Renderer: `History.tsx` (tab, form commit dengan tombol asisten, viewer commit dan perubahan), `Collab.tsx` (tab, dialog token dengan Test, form Send Changes), `Pull.tsx` (halaman review: file, tampilan Note/Raw, diskusi, merge, resolve lokal), dan `Diff.tsx` (satu komponen diff untuk proposal, history, dan pull request). Rail sekarang punya History dan Pull requests. Tes: 14 skenario baru di `tests/unit/protocol.ts` (repositori git nyata dan forge palsu lewat `CollabServices`), `tests/electron-git.mjs` (git nyata, forge palsu `tests/electron-forge.mjs` dimuat core lewat `MARKWORK_TEST_FORGE`). `unwired` menyusut dari 15 ke 7 (`dialogs.harness`, `dialogs.preferences`, `dialogs.review`, `frontendCommands.edit`, `host.board.setRuns`, `host.logs`, `host.reviewView`). Belum: `npm run test:forgejo` terhadap Electron (butuh Podman/Docker dan Forgejo sungguhan; skenario yang sama dengan forge palsu sudah jalan), kirim perubahan sampai push sungguhan lewat Electron (`forge/contribute.ts` punya tes sendiri di `tests/unit/contribute.ts`), dan jendela viewer terpisah (viewer adalah dialog di jendela utama).

- **History**: `view.history`, `view.historyChanges`, `history.messageText`, dan aksi `act.history.*` (`protocol.md` 6.5). Kotak pesan commit dengan tombol sparkle (pesan ditulis streaming oleh core).
- **History viewer**: `view.historyViewer.*` sebagai dialog besar di jendela utama, dengan tab Changes dan Contents; `ask.discard`.
- **Collab**: `view.collab`; `act.collab.*`; `ask.token` dengan tombol Test (`act.collab.testToken`).
- **Review pull request**: `view.pull` dan `act.pull.*` sebagai halaman di area konten (`showPull`); `ask.pull.merge` dan sejenisnya.
- **Kirim perubahan**: `ask.sendChanges` (form `SendChangesOptions`).
- Komponen diff dibuat sekali (`DiffLine[]`) dan dipakai ulang oleh history, pull request, proposal, dan review worktree.

Selesai bila: `tests/gui/history.ts`, `collab.ts`, `forgejo.ts` punya padanan; `npm run test:forgejo` dijalankan juga terhadap Electron.

### Fase 6 — Agent dan harness (L)

**Status (20 Oktober 2026):** selesai. Core: `src/app/protocol/harness.ts` (`ProtocolRuns`, `ProtocolHarnessLogs`, `ProtocolHarnessDialogs`, `ProtocolReviewView`, `ProtocolReviewDialogs`) dan `ProtocolPreferencesDialogs` di `preferences.ts` mengubah `HarnessBoard`, `HarnessLogs`, `HarnessDialogs`, `ReviewView`, `ReviewDialogs`, dan `PreferencesDialogs` menjadi notice `view.runs`, `view.runlog.open/update`, `view.review.show`, `view.review` dan ask `ask.folder`, `ask.harness.answer`, `ask.text`, `ask.remoteFolder`, `ask.closeAgents`, `ask.review.merge/discard`, `ask.pullRequest`, `ask.machine`, `ask.removeWorktree`; `handlers/harness.ts` menerima `act.card.menu/run`, `act.runlog.clear/closed`, `act.review.*`, dan `handlers/preferences.ts` menerima `act.prefs.addMachine/removeMachine/openProject/setProject/removeWorktree`. Menu kartu tidak jadi `ask.menu` dari core: pengguna yang membuka menu, jadi frontend bertanya `act.card.menu {column, index, text}` (kartu harus yang dipegang core, kalau tidak `stale`; papan yang dikelompokkan tidak punya menu agent) dan menjalankan satu entri dengan tokennya (`act.card.run`). Frontend tidak pernah memilih apa yang ditulis: jawaban harness dibaca terhadap pertanyaannya (pilihan harus salah satu opsinya, konfirmasi hanya ya atau tidak), jendela log hanya bisa dikosongkan selama terbuka, berkas dan baris review harus yang dikirim halaman (`stale` kalau tidak), aksi akhir review harus `merge`, `squash`, `keep`, atau `discard`, jawaban `ask.pullRequest` dibaca terhadap tawarannya (jalur `direct` hanya kalau token boleh push), proyek dan worktree di Preferences harus yang didaftar core, dan perubahan proyek diperiksa kolom demi kolom (`ProjectsPages.set`). Pertanyaan saat jendela ditutup dengan agent bekerja (`ask.closeAgents`) lewat `app.close`. `unwired` menyusut dari 7 ke 1 (`frontendCommands.edit`, milik perintah editor). Renderer: `Review.tsx` (halaman review: berkas dengan kotak, diff dengan komentar per baris, ringkasan, Reply, Merge, Keep Branch, Discard, Create Pull Request), `Harness.tsx` (jawab harness, teks untuk agent, Add a Machine, form pull request), `LogViewer.tsx` (`LogPanel` dipakai Assistant dan run), `AgentsPrefs.tsx` (halaman Agents di Preferences dan halaman proyek), dan lencana status serta menu kartu di `Board.tsx`. Pilihan daemon lokal disembunyikan di luar Linux (`AgentsPage`). Tes: sepuluh skenario baru di `tests/unit/protocol.ts` (proses agent palsu lewat `orchestrator.spawn`, repositori git nyata untuk review dan merge), `tests/electron-harness.mjs` (agent palsu `tests/electron-agent.mjs` dimuat core lewat `MARKWORK_TEST_HARNESS`; folder proyek lewat `MARKWORK_PICK_FOLDER`) sebagai padanan `harness` dan `agentshost`. Belum: `tests/unit/daemon-fake.ts` dengan frontend protokol (daemon palsu ada di tes core sendiri, tidak lewat Electron), tombol Terminal memakai terminal sistem lewat `platform().processes.openTerminal` (terminal bawaan Electron nanti), jendela log dan review adalah dialog dan halaman di jendela utama (bukan jendela terpisah), dan run yang diikuti lagi dari daemon belum diuji lewat Electron.

- **Menu kartu**: `ask.menu {at, entries}` → token (`protocol.md` 6.4). Status run masuk ke kartu lewat `view.notes`.
- **Log run**: `view.runlog` dengan `TraceUpdate`, `act.runlog.clear` dan `.closed`. Viewer log Fase 4 dipakai ulang.
- **Dialog harness**: `ask.folder`, `ask.harness.answer`, `ask.text`, `ask.remoteFolder`, `ask.closeAgents` (juga dipanggil saat jendela ditutup).
- **Review worktree**: `view.review` + `act.review.*`, `ask.review.merge`/`discard`, `ask.pullRequest`. Tombol Terminal memakai `platform().processes.openTerminal`, atau terminal bawaan Electron nanti.
- **Preferences → Agents**: mesin (`ask.machine`), proyek, isolasi, worktree (`ask.removeWorktree`).
- **Status `markworkd`** di Home dan Preferences (`agentHost()`). Di macOS dan Windows daemon belum ada (`electron.md`, status celah), jadi agent berjalan sebagai proses anak dan UI menyembunyikan pilihan daemon lokal.

Selesai bila: `tests/gui/harness.ts`, `agentshost.ts` punya padanan, dan `tests/unit/daemon-fake.ts` dijalankan dengan frontend protokol.

### Fase 7 — Platform dan rilis (M–L)

**Status (20 Oktober 2026):** selesai, dengan yang belum bisa dicoba di sini disebut di bawah. `Secrets`: `src/platform/node/vault.ts` (`SecretVault` di main memegang item terenkripsi `safeStorage` di `userData/secrets.json`, `answerSecret` menjawab permintaan, `remoteSecrets` jadi `Secrets` di core lewat `process.parentPort`); `electron/core.ts` memasangnya di luar Linux (di Linux tetap `secret-tool`, jadi kunci dibagi dengan aplikasi GTK; `MARKWORK_SECRETS=vault` memaksanya untuk tes) dan permintaan yang tidak dijawab berakhir sebagai "tidak ada keyring". i18n: `scripts/electron-build.mjs` mengompilasi `po/<lang>.po` dari `po/LINGUAS` dengan `msgfmt` ke `dist-electron/locale/`, dan core membacanya dari sana (belum ada bahasa terdaftar, jadi tidak ada `.po` yang diuji selain satu berkas sementara). Packaging: `electron-builder.yml` (AppImage dan deb, dmg dan zip, nsis; ikon `build/icon.png` dari `scripts/make-icon.cjs`; entitlements macOS; tanda tangan dan notarisasi dari variabel lingkungan, dilewati kalau tidak ada) dengan `npm run electron:dist` dan `electron:pack`; `electron/updater.ts` (electron-updater, hanya paket yang bisa memperbarui diri: bukan dev, bukan deb, bukan `MARKWORK_NO_UPDATE`). CI: `.github/workflows/ci.yml` (core di Node dan tes Electron di tiga OS) dan `release.yml` (installer saat tag `v*`). Tes: empat skenario di `tests/unit/nodeplatform.ts`, `tests/electron-secrets.mjs`; build `--dir` di Linux dijalankan dan aplikasinya dibuka. **Belum diuji di sistem aslinya:** `safeStorage` dengan keychain macOS dan Windows, dmg, nsis, tanda tangan, notarisasi, dan update otomatis (`markworkd` tidak ikut dibundel). CI tiga OS hijau pada 20 Oktober 2026. Menjadikannya hijau menemukan dan menutup bug port Node di Windows dan macOS: `inRepository` berputar selamanya di `C:\` (akar Windows adalah induk dirinya sendiri), prefix path hanya dengan `/` (`markdown/pathbelow.ts`), perintah PowerShell untuk Recycle Bin yang tidak valid, path dari git (`C:/…`, `/private/var`) yang tidak cocok dengan folder pengguna (puncak repositori kini dari `--show-cdup`), gambar dan halaman HTML dari folder Windows, menu bawaan macOS yang mengambil Cmd+W, `XDG_CONFIG_HOME` yang diabaikan di macOS dan Windows, dan palette perintah yang menghapus teks yang baru diketik. Job macOS dan Windows masih `continue-on-error`.

**Keputusan multi-jendela: tetap satu jendela.** Satu `AppSession` memegang satu folder, dokumen terbuka, dan satu antrean agent; jendela kedua berarti satu utility process lagi dengan sesi sendiri, dan dua sesi pada folder yang sama akan berebut `Files` dan antrean harness. GTK juga satu jendela utama. `app.on('activate')` hanya membuat ulang jendela di macOS. Kalau nanti dibutuhkan, bentuknya sudah jelas (satu `utilityProcess` dan satu `MessageChannelMain` per jendela, `core-exit` per jendela), tetapi itu fitur baru, bukan bagian rilis.

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
