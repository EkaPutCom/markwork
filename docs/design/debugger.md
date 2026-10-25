# Arsitektur Editor Inspector

25 Oktober 2026 · keempat tahap sudah dibangun (bagian 14) · mockup: [`shadcn/Debugger.html`](shadcn/Debugger.html)

## Keputusan

- **Panel inspector, jembatan untuk agent, dan checks hanya ada di mode dev** (`--inspect-editor` atau `MARKWORK_DEV=1`).
  Build biasa tidak punya panel, juga tidak lewat Preferences.
- **Laporan pengguna tetap ada di build biasa.** Yang berjalan untuk itu hanya perekam (bagian 4). Tidak ada check yang
  berjalan diam-diam: laporan cukup membawa rekaman, dan check dijalankan oleh developer atau agent saat repro diputar
  ulang (`replay`, bagian 10).
- **Penyamaran hanya mengganti huruf Latin dan angka.** Emoji dan aksara non-Latin dibiarkan apa adanya untuk saat ini
  (bagian 9), supaya bug lebar dan offset tetap bisa diputar ulang.
- **Rekaman menyimpan 500 transaksi terakhir**, tanpa batas waktu (bagian 4).

Editor visual adalah inti Markwork: Markdown yang tampil seperti dokumen biasa, untuk orang yang tidak tahu Markdown. Ia juga
sumber bug terbanyak, dan hampir semuanya punya satu sebab yang sama (AGENT.md, *Known pitfalls*): yang dilihat mata dan
yang ada di teks berbeda. Sintaks yang disembunyikan tetap punya posisi, jadi satu tempat di layar bisa berarti beberapa
posisi di teks, dan tombol bekerja pada teks, bukan pada yang terlihat.

Saat ini bug seperti itu dicari dengan membaca kode dan menambah langkah di `tests/electron/visual.mjs`. Dokumen ini
merancang alat yang membuat celah itu terlihat: apa yang disembunyikan, transaksi apa yang terjadi, dan aturan mana
yang dilanggar. Alat ini dipakai developer (lewat panel) dan agent AI (lewat perintah yang menjawab JSON), dan bug yang
ditemukan pengguna biasa bisa dikirim dalam format yang sama.

## 1. Tujuan dan bukan tujuan

Tujuan

- **Satu sumber kebenaran untuk developer dan agent.** Setiap tab panel adalah satu perintah, dan setiap perintah adalah
  satu tab. Agent tidak perlu menebak dari screenshot, dan developer tidak perlu membaca JSON.
- **Bug yang terlihat sekali bisa diputar ulang.** Sebuah rekaman (`.mwrepro.json`) memuat teks awal, kursor, dan
  langkah-langkahnya, lalu bisa dijadikan langkah tes.
- **Aturan editor visual ditulis sebagai kode yang memeriksa,** bukan hanya sebagai prosa di AGENT.md. Aturan seperti
  "Backspace menghapus yang terlihat" dan "kursor tidak masuk prefix" dicek setelah setiap transaksi.
- **Tidak memperlambat pengetikan.** Di build biasa yang berjalan hanya perekam yang murah (bagian 4).

Bukan tujuan

- Debugger umum untuk renderer. DevTools Chromium sudah ada; alat ini khusus untuk `MarkdownEditor`.
- Mengirim laporan lewat jaringan. Laporan pengguna hanya disimpan sebagai berkas (bagian 11).
- Mengubah perilaku editor. Inspector hanya mengamati. Satu-satunya pengecualian adalah `press`/`type`/`click` dari
  agent, dan itu dikirim sebagai input sungguhan, sama seperti dari orang.

## 2. Gambaran besar

```
                       ┌──────────────── renderer (halaman) ────────────────┐
  orang mengetik ───▶  │  MarkdownEditor (CodeMirror)                       │
                       │    ├─ recorder()      transaksi → ring buffer      │   selalu ada
                       │    ├─ snapshot()      teks + yang tersembunyi       │   hanya mode dev
                       │    └─ checks          aturan per transaksi          │   hanya mode dev
                       │  InspectorPanel (React)   ◀── membaca tiga di atas │   hanya mode dev
                       └──────────────▲────────────────────────▲────────────┘
                                      │ ipc 'inspect'          │ sendInputEvent (tombol, klik)
                       ┌──────────────┴──── main (Electron) ───┴────────────┐
                       │  inspectBridge: socket JSON per baris              │   hanya mode dev
                       └──────────────▲─────────────────────────────────────┘
                                      │ $XDG_RUNTIME_DIR/markwork/inspect-<pid>.sock
                       ┌──────────────┴─────────────────────────────────────┐
                       │  scripts/editor.mjs  (npm run editor -- …)         │   agent, CI, developer
                       └────────────────────────────────────────────────────┘
```

Ada empat bagian:

1. **Perekam**, di renderer. Ia mencatat setiap transaksi CodeMirror beserta input yang memicunya. Ia selalu aktif
   karena laporan pengguna (bagian 11) membutuhkannya, dan biayanya kecil.
2. **Snapshot dan checks**, di renderer. Snapshot adalah keadaan editor sebagai data, sedangkan checks adalah aturan
   yang dijalankan pada (state sebelum, transaksi, state sesudah). Keduanya hanya ada di mode dev.
3. **Panel inspector**, di renderer. Panel ini menampilkan bagian 1 dan 2 seperti di board 1 mockup, dan hanya ada di
   mode dev.
4. **Jembatan**, yaitu `inspectBridge` di main ditambah `scripts/editor.mjs`. Bagian ini membuka keadaan yang sama untuk
   proses lain dalam bentuk JSON, dan hanya ada di mode dev.

Core (`src/app/`, utility process) tidak terlibat. Inspector mengamati editor, dan editor adalah milik renderer (AGENT.md:
*the editor owns the live text*). Karena itu inspector tidak menambah pesan di `app/protocol/`.

## 3. Di mana kodenya

| Berkas | Isi |
| --- | --- |
| `electron/renderer/lib/inspect/recorder.ts` | Extension `recorder()`, ring buffer, `Recording` |
| `electron/renderer/lib/inspect/snapshot.ts` | `snapshot(view, at?)`: teks, seleksi, hidden, prefix, widget, dekorasi, parse di sekitar kursor |
| `electron/renderer/lib/inspect/checks.ts` | Daftar check (bagian 6), masing-masing berupa fungsi murni di atas state CodeMirror |
| `electron/renderer/lib/inspect/repro.ts` | Format `.mwrepro.json`: membuat, membaca, dan menyamarkan repro (bagian 9). Murni, juga dipakai main untuk memeriksa laporan |
| `electron/renderer/lib/inspect/report.ts` | Repro dari editor yang sedang tampil, laporan pengguna tanpa `expect`, dan gambar editor dengan teks tersamar (bagian 11) |
| `src/markdown/blur.ts` | `blurText()`: aturan penyamaran (bagian 9), murni, dengan unit test di `tests/unit/blur.ts` |
| `electron/renderer/lib/inspect/bridge.ts` | Menjawab permintaan `inspect` dari main |
| `electron/renderer/components/Inspector.tsx` | Panel dan dock (Transactions, Decorations, Checks, Replay & test) |
| `electron/renderer/components/ReportProblem.tsx` | Dialog "Something looks wrong?" dan link yang menawarkannya setelah Undo |
| `electron/inspect.ts` | `inspectBridge`: socket, framing, dan input lewat `webContents.sendInputEvent` |
| `electron/main.ts`, `preload.ts` | Memuat `inspect.ts` hanya dengan flag (bagian 8.1), dan `saveReport` untuk bagian 11 |
| `scripts/editor.mjs` | Klien baris perintah, `npm run editor -- <op>` |
| `tests/electron/inspector.mjs` | Tes alat ini sendiri (bagian 13) |

Renderer dibundel menjadi satu skrip (`scripts/electron-build.mjs`, format IIFE), jadi kode inspector ikut di dalamnya,
tetapi di build biasa hanya `recorder.ts` (dan nanti `repro.ts`) yang berjalan. `watchChecks()` hanya dipanggil di
`main.tsx` bila `window.markwork.devMode`, dan `Inspector.tsx` hanya dipasang lewat pintasannya, yang juga hanya ada di
mode dev. `electron/inspect.ts` (tahap 2) dimuat oleh main hanya dengan flag.

Aturan lapisan tetap berlaku. Kode inspector di renderer memakai bagian murni dari `src/` yang sudah dipakai editor
(`markdown/highlight.ts`, `markdown/table.ts`, `markdown/offsets.ts`) dan tidak mengimpor Node. Kalau sebuah check
butuh aturan Markdown baru, aturannya masuk ke `src/markdown/` dan diberi unit test, bukan ditulis ulang di `checks.ts`
(AGENT.md: *Text logic is pure and shared*). Bila `scripts/layers.mjs` menolak sebuah impor, yang dipindah adalah kodenya,
bukan aturannya.

`MarkdownEditor` (`editor.ts`) hanya mendapat dua tambahan:

- `recorder()` ikut dalam daftar extension di `fresh()`, satu `Recording` per tab, dan ikut terbuang bersama state tab.
- `inspectable(): InspectTarget` memberi inspector akses baca ke `view`, field `drawn` (dekorasi dan `Concealed`),
  `parses`, dan `Recording` tab itu. Field `drawn` saat ini dibuat di dalam `fresh()` dan tidak diekspor, jadi akses ini
  menjadi pintunya, satu-satunya.

Kalau editor sedang di-split (`panes.ts`), inspector mengikuti pane yang terakhir fokus. Setiap jawaban JSON memuat
`pane` dan `tab`, sehingga agent tahu teks mana yang sedang dibacanya.

## 4. Perekam

Satu entri per transaksi:

```ts
interface TxEntry {
    n: number;                     // nomor urut di rekaman ini
    t: number;                     // performance.now() saat transaksi
    userEvent: string | null;      // Transaction.userEvent: 'input.type', 'delete.backward', 'select.pointer', 'undo', …
    changes: ChangeJSON;           // tr.changes.toJSON(), dalam offset UTF-16
    selBefore: [number, number][]; // anchor/head per range
    selAfter: [number, number][];
    effects: string[];             // nama efek yang dikenal (setVisual, setSource, linkEdit, …), selain itu 'effect'
    input?: InputEntry;            // tombol/klik/tempel yang memicunya, kalau ada
    handler?: string;              // perintah yang menangani tombol itu, kalau dilacak (di bawah)
}
interface InputEntry { kind: 'key' | 'click' | 'paste' | 'drop' | 'compose'; key?: string; mods?: string; x?: number; y?: number; pos?: number }
```

Cara kerjanya:

- **Input.** `EditorView.domEventHandlers` (keydown, mousedown, paste, drop, compositionend) hanya menyimpan event
  terakhir di satu slot dan tidak pernah menangani event itu (mengembalikan `false`). Transaksi berikutnya dalam 50 ms
  mengambil isi slot tersebut. Teks yang ditempel tidak disalin ke `input`, karena sudah ada di `changes`.
- **Transaksi.** `EditorView.updateListener` membaca `update.transactions`. Inilah yang dipakai editor sendiri untuk
  `changed`/`moved`, jadi tidak ada jalur kedua.
- **Ring buffer.** Rekaman menyimpan maksimal 500 entri, tanpa batas waktu. Rekaman memegang
  `base: { doc: Text; selection }`. Saat entri tertua dibuang, `changes`-nya diterapkan ke `base.doc`. `Text` CodeMirror
  persisten, jadi operasi ini O(log n) dan tidak memerlukan `doc.toString()`.
- **Efek.** `StateEffect` tidak punya nama. Karena itu `recorder.ts` memegang daftar efek yang dikenal (`setVisual`,
  `setSource`, `setFocus`, …). Efek baru yang penting untuk debugging didaftarkan di sana.
- **Handler (opsional, fase 4).** CodeMirror tidak memberi tahu perintah mana yang menangani sebuah tombol. Perintah di
  keymap editor visual dibungkus `traced('visual.backspace', backspace)`, yang menulis namanya ke slot ketika perintah
  mengembalikan `true`. Nama fungsi asli tidak bisa dipakai karena hilang saat bundle di-minify. Selain itu,
  `trace(msg)` di beberapa titik keputusan (misalnya `pastHidden`) menambah baris ke entri. Di luar mode dev, fungsi
  ini tidak melakukan apa pun, dan pemakaiannya dibatasi pada tempat yang memang pernah menjadi sumber bug.

Biaya di build biasa (hanya perekam): satu objek kecil per transaksi dan tanpa salinan teks. Batasnya < 0,05 ms per transaksi,
diukur seperti di bagian 12.

## 5. Snapshot

`snapshot(view, at?)` memotret keadaan editor sebagai data biasa. Bagian atas board 1 dan perintah `snapshot` membaca
fungsi yang sama.

```json
{
  "pane": 0, "tab": 3, "path": "Rencana rilis.md", "mode": "visual", "length": 88, "lines": 4,
  "selection": [[36, 36]], "cursor": { "pos": 36, "line": 2, "col": 21, "inPrefix": false },
  "around": { "before": "Jumat**", "after": " setelah", "visibleBefore": { "char": "t", "at": [33, 34] } },
  "hidden": [[0, 2, "# "], [21, 23, "**"], [34, 36, "**"]],
  "prefixes": [[0, 2], [49, 55], [71, 77]],
  "widgets": [{ "at": [49, 55], "kind": "ListMarkWidget", "detail": "task" }],
  "decorations": [{ "at": [23, 34], "kind": "mark", "class": "cm-md-bold" }],
  "parse": { "line": 2, "spans": [["cm-md-bold", 7, 18]] },
  "timing": { "parseMs": 0.4, "drawMs": 1.1 }
}
```

- **Offset memakai UTF-16,** sama dengan CodeMirror dan `changes`. Ini berbeda dengan protokol app, yang menghitung
  code point (AGENT.md, *Text positions*). Karena itu setiap posisi yang menunjuk tempat di teks juga diberi `cp` (code
  point) bila keduanya berbeda, dan perintah menerima `--cp` untuk memakai satuan itu.
- **`visibleBefore`/`visibleAfter`** adalah karakter terlihat terdekat, setelah melompati semua range tersembunyi. Ini
  bahasa yang sama dengan cara orang melihat teks, dan yang paling sering dibutuhkan agent.
- Secara default, `decorations` dan `parse` dibatasi pada baris kursor ±3. `--all` mengambil semuanya.

## 6. Checks

Sebuah check adalah fungsi `(before: EditorState, tr: Transaction, after: EditorState, ctx: CheckContext) => Finding | null`,
dengan `ctx` memberi `Concealed` dan parse untuk kedua state. Setiap check punya nama tetap, karena nama itu dipakai di
CLI, di repro, dan di tes.

| Nama | Aturan | Kapan |
| --- | --- | --- |
Semua check di tabel ini sudah ada di `renderer/lib/inspect/checks.ts`. Cara kerja tiga di antaranya lebih sempit dari
deskripsi di tabel:

- `hidden-on-syntax` membandingkan setiap range tersembunyi dengan `markers` dari parse (dikonversi ke UTF-16). Range
  yang hanya berisi spasi, yaitu spasi di antara dua gambar, juga diterima.
- `marks-closed` menghitung `*`, `_`, `~`, `=`, dan `` ` `` yang tersembunyi per baris yang berubah. Jumlah yang ganjil
  dilaporkan sebagai peringatan. Penanda yang melintasi baris dalam satu paragraf belum dikenali.
- `undo` hanya memeriksa edit yang membuat langkah baru di riwayat (`undoDepth` bertambah satu). Edit yang digabung ke
  langkah sebelumnya (ketikan dalam setengah detik) ikut dibatalkan bersama langkah itu, sehingga tidak bisa
  dibandingkan dengan teks tepat sebelumnya.

| `backspace-visible` | `delete.backward`/`delete.forward` dengan kursor kosong menghapus karakter terlihat terdekat (melewati yang tersembunyi), menghapus satu prefix, atau objek yang dipilih (`blockselect.ts`). Tidak pernah menghapus sebagian range tersembunyi | transaksi hapus |
| `prefix-guard` | Kursor tunggal tidak berada di dalam `(line.from, prefixEnd)` | setiap transaksi yang menggeser seleksi |
| `hidden-on-syntax` | Setiap range tersembunyi hanya menutupi token penanda dari parse (HeaderMark, EmphasisMark, ListMark, TaskMarker, link, fence, gambar) | setelah gambar ulang, untuk baris yang berubah |
| `marks-closed` | Penanda inline yang disembunyikan punya pasangan. Ini peringatan, bukan kegagalan | setelah gambar ulang |
| `local-change` | Pengetikan atau penghapusan hanya mengubah teks di sekitar seleksi. Perintah yang memang mengubah blok (format, tabel, daftar) dikecualikan berdasarkan `userEvent` | transaksi yang mengubah teks |
| `undo` | Pada salinan state, `undo` atas transaksi ini mengembalikan teks persis seperti sebelumnya | transaksi yang membuat langkah riwayat baru |
| `no-overlap` | Tidak ada dua dekorasi `replace` yang bersilangan | setelah gambar ulang |
| `tables` | Setiap baris tabel yang disentuh punya jumlah kolom yang sama dengan header (`markdown/table.ts`) | transaksi yang mengubah tabel |
| `kept-drawing` | Gambar yang dipertahankan saat seleksi pindah (`selectionKey` di `editor.ts`) sama dengan gambar baru: dekorasi, range tersembunyi, dan prefix (`RangeSet.eq`) | perubahan seleksi yang tidak menggambar ulang |
| `draw-time` | `build()` di `syntaxField` < 8 ms | setiap gambar ulang |

Mockup menulis check *Markdown round trip*. Check itu tidak ada di sini, karena di Markwork teks Markdown adalah satu-satunya
sumber (tidak ada model lain yang diserialisasi balik), sehingga round trip selalu lulus. Yang bisa rusak adalah
perubahan di luar tempat orang mengetik, dan itu tugas `local-change`.

Kapan checks berjalan:

- **Mode dev:** semua check berjalan untuk setiap transaksi di `requestIdleCallback`, di luar jalur pengetikan.
  `undo` bekerja pada salinan, jadi tidak menyentuh riwayat yang sebenarnya.
- **Build biasa:** tidak ada check yang berjalan, juga tidak diam-diam. Laporan pengguna tidak membutuhkannya: repro
  membawa langkah-langkahnya, dan check berjalan ketika developer atau agent memutarnya ulang. Ini juga menghindari alarm
  palsu di depan orang yang tidak tahu Markdown.
- **Replay dan fuzz:** semua check berjalan sinkron setelah setiap langkah, karena di sini kecepatan tidak penting.

`Finding` berisi `{ check, tx, severity: 'fail' | 'warn', message, detail }`. Pesannya ditulis untuk manusia dengan
posisi dan teks yang konkret, seperti di mockup: "removed 35–36 `"*"`, which was hidden; the letter before the cursor was `"t"`".

## 7. Panel inspector

- **Hanya ada di mode dev.** Panel dibuka dan ditutup dengan `Ctrl+Alt+I`, yang ditangani di `App.tsx` hanya bila
  `window.markwork.devMode`. Rancangan awal memakai `Ctrl+Shift+E`, tetapi tombol itu sudah dipakai Export HTML. Belum ada
  perintah palet: perintah palet adalah tabel `app/commands.ts` milik core, sedangkan inspector sengaja tidak menyentuh
  core. Build biasa tidak punya jalan ke panel ini, termasuk lewat Preferences.
- **Tampil** sebagai dock di bawah area editor, seperti DevTools. Tinggi dock diatur dengan menarik garisnya, dan editor
  di atasnya tetap bisa dipakai.
- **Dua tampilan teks.** *Visual* adalah editor sungguhan. Selama panel terbuka, host editor mendapat class
  `inspecting` dan setiap widget (`[contenteditable=false]`) diberi garis. Range tersembunyi tidak bisa ditandai di
  sana karena tidak punya DOM. *Source* ada di kiri dock: baris sekitar kursor (±12) sebagai teks file, dengan range
  tersembunyi bergaris, widget pengganti bergaris tepi, prefix bergaris bawah, offset di gutter, dan offset tiap potongan
  di tooltip-nya. Di bawahnya ada baris status (kursor, di dalam prefix atau tidak, karakter terlihat sebelum kursor,
  waktu gambar). Mockup menaruh kedua tampilan di atas dock; di app, Source ada di dalam dock supaya editor tetap
  mendapat tinggi penuh.
- **Sorotan silang.**
  - Saat pointer berada di atas potongan Source, potongan itu diberi kotak di editor. Kotaknya digambar dari
    `coordsAtPos` sebagai elemen `position: fixed`, tanpa transaksi, jadi editor tidak berubah dan log tidak terisi.
    Range tersembunyi tidak punya lebar, jadi tampil sebagai garis.
  - Sebaliknya, tempat di bawah pointer di editor (`posAtCoords`) menyalakan potongan yang memuatnya di Source.
  - Keduanya hanya bekerja di mode Live.
- **Live dan Paused.** *Paused* dimulai dari transaksi terakhir. ◀/▶ dan klik baris memindahkannya, lalu Source, baris
  status, dan Decorations menampilkan state yang ditinggalkan transaksi itu. State itu tidak disusun ulang dari
  `changes`, karena dekorasinya harus persis seperti saat itu. Di mode dev, `watchChecks` menyimpan `tr.state` setiap
  entri di `WeakMap` milik entri tersebut (`stateAfter` di `checks.ts`), sehingga state ikut hilang ketika perekam
  membuang entrinya. Di build biasa tidak ada state yang disimpan.
- **Tab dock** (Transactions, Decorations, Checks, Replay & test) membaca `Recording`, `snapshot()`, dan `Finding[]`
  yang sama dengan yang dibaca CLI.
- **Tampilan** mengikuti shadcn/ui seperti bagian app lain (`docs/design/shadcn/`). Panel ini alat developer, jadi teksnya
  tidak diterjemahkan.

## 8. Jembatan untuk agent

### 8.1 Menyalakan

Jembatan hanya ada bila app dijalankan dengan `--inspect-editor` atau `MARKWORK_DEV=1`. Tanpa salah satunya, `electron/inspect.ts`
tidak dimuat, tidak ada socket, dan preload tidak membuka `onInspect`. Flag yang sama menyalakan panel (bagian 7) dan
checks (bagian 6), jadi "mode dev" berarti satu hal saja.

### 8.2 Transport

Transport sengaja disamakan dengan markworkd (`docs/design/markworkd.md` bagian 3) supaya satu cara berpikir berlaku
untuk keduanya:

- Unix socket di `$XDG_RUNTIME_DIR/markwork/inspect-<pid>.sock` (lewat `platform().paths.runtimeDir()`), dengan folder
  `0700` dan socket `0600`. Di Windows dipakai named pipe `\\.\pipe\markwork-inspect-<pid>`.
- JSON satu pesan per baris: `{"id","op",...}` → `{"re","ok",...}` atau `{"re","ok":false,"error":{code,message}}`, ditambah
  push `{"ev":"tx",...}` untuk `log --follow`.
- `scripts/editor.mjs` mencari socket milik proses yang masih hidup. Bila ada lebih dari satu, ia meminta `--pid`.

### 8.3 Siapa menjawab apa

- **Membaca** (`snapshot`, `log`, `decorations`, `check`): main meneruskan permintaan ke renderer lewat
  `webContents.send('inspect', req)`, lalu `bridge.ts` menjawab lewat `ipcRenderer.invoke('inspect-reply', …)`.
- **Bertindak** (`press`, `type`, `click`, `select`):
  - `press`/`type` memakai `webContents.sendInputEvent` di main. Input ini lewat jalur input Chromium seperti tombol
    sungguhan, jadi keymap, `domEventHandlers`, dan perekam bekerja persis seperti saat orang mengetik. Pendekatan
    ini sama dengan yang dipakai tes lewat Playwright.
  - `click --visible "Jumat" --end` meminta renderer mencari teks terlihat itu dan `coordsAtPos`-nya, lalu main
    mengirim mousedown/mouseup ke koordinat tersebut. Ini sesuai dengan AGENT.md, *Drive the editor the way a
    person does*: klik pada yang terlihat, bukan memasang posisi.
  - `select FROM TO` adalah satu-satunya perintah yang langsung men-`dispatch` seleksi, dan perintah itu ditandai
    `userEvent: 'select.inspect'` supaya terlihat di log.
- **`--explain`** pada perintah bertindak menunggu transaksi yang dipicunya (sampai 500 ms tanpa transaksi baru), lalu
  menjawab dengan entri-entri itu beserta `Finding` setelahnya.

### 8.4 Perintah

`npm run editor -- <op>` (nama `markwork editor` di mockup adalah perintah yang sama). Keluaran berupa JSON di stdout,
atau teks yang mudah dibaca dengan `--pretty`. Kode keluar 1 bila ada check yang gagal, 2 bila ada kesalahan pemakaian
atau koneksi.

| Op | Hasil |
| --- | --- |
| `snapshot [--at cursor\|POS] [--all]` | Bagian 5 |
| `press KEY…`, `type TEXT` | Input sungguhan. `--explain` menambah transaksi, handler, dan temuan |
| `click --visible TEXT [--start\|--end]`, `click --pos N` | Klik pada yang terlihat |
| `select FROM [TO]` | Seleksi langsung |
| `log [--since N] [--flagged] [--follow]` | Entri perekam |
| `decorations [--line N]` | Dekorasi beserta pembuatnya |
| `check [NAME…]` | Menjalankan checks pada keadaan sekarang (check yang butuh transaksi memakai transaksi terakhir) |
| `open PATH`, `mode visual\|source` | Menyiapkan keadaan |
| `save-repro FILE`, `load FILE`, `replay FILE` | Bagian 9 dan 10 |
| `fuzz …`, `test-from FILE` | Bagian 10 |
| `screenshot [--overlay] FILE` | `webContents.capturePage` dari area editor, dengan overlay bila diminta (untuk screenshot yang diminta AGENT.md) |

### 8.5 Headless

`npm run editor -- --headless <op>…` menjalankan app sendiri seperti `launchApp` di `tests/electron/support.mjs`:
folder scratch, `XDG_CONFIG_HOME`/`XDG_DATA_HOME` di dalamnya, `--inspect-editor`, dan `xvfb-run` di Linux bila tidak
ada `DISPLAY`. Setelah itu ia bicara lewat socket yang sama. Karena hanya ada satu jalur, apa yang dilihat agent di CI
sama dengan apa yang dilihat developer di jendela app. Proses app berhenti ketika skrip selesai, atau tetap hidup dengan
`--keep` agar beberapa perintah bisa dijalankan berturut-turut.

## 9. Format repro

```json
{
  "format": "markwork-repro", "version": 1,
  "app": { "version": "1.0.0", "commit": "adcfa20", "os": "linux", "electron": "44.9.0" },
  "editor": { "mode": "visual", "focus": false, "typewriter": false, "width": 680 },
  "start": { "doc": "# Rencana rilis\n…", "selection": [[36, 36]] },
  "steps": [
    { "key": "Backspace" },
    { "type": "abc" },
    { "click": { "visible": "Jumat", "edge": "end" } },
    { "select": [10, 14] }
  ],
  "expect": { "doc": "…", "checks": "pass" },
  "actual": { "doc": "…", "failed": ["backspace-visible"] },
  "note": "teks dari pengguna, bila ada",
  "blurred": false
}
```

- **Langkah adalah input, bukan transaksi.** Repro diputar ulang dengan menekan tombol, sehingga perubahan pada kode
  editor ikut teruji. Kalau yang diputar ulang adalah `changes`, hasilnya pasti sama dengan rekaman dan bug tidak akan
  muncul lagi. `TxEntry.input` adalah bahan langkah ini, sedangkan transaksi tanpa input (misalnya dari core) menjadi
  `{ "external": changes }`.
- **`width`** ikut disimpan, karena baris yang membungkus (`lineWrapping`) mengubah ke mana klik dan panah atas/bawah
  mendarat.
- **Penyamaran** (`blurred: true`, bagian 11) mengganti setiap huruf Latin dengan `x`/`X` (mengikuti huruf
  besar-kecilnya) dan setiap angka dengan `0`, hanya di dalam isi teks menurut parse. Penanda (`**`, `- [x]`, `#`,
  fence, `|`) tidak diubah. Karena penggantinya selebar yang diganti, semua offset, seleksi, dan langkah tetap
  berlaku. URL disamarkan dengan cara yang sama kecuali skemanya. Emoji dan aksara non-Latin (misalnya Arab, Cina,
  atau Devanagari) dibiarkan apa adanya: keduanya sering menjadi sumber bug lebar dan offset, dan menggantinya bisa
  menghilangkan bug itu. Akibatnya teks dalam aksara non-Latin ikut terbaca di laporan, dan pratinjau dialog
  (bagian 11) memperlihatkannya kepada pengguna sebelum disimpan.

## 10. Replay, fuzz, dan tes

- **`replay FILE`** membuka teks `start` di tab baru tanpa berkas dan dengan pengaturan editor dari `editor`, menjalankan
  setiap langkah dengan checks sinkron, lalu membandingkan hasilnya dengan `expect`. Hasilnya `pass`, `fail` (beserta
  langkah dan temuan pertama), atau `differs` (teks berbeda dari `expect`, tetapi semua check lulus).
- **`fuzz --docs GLOB --keys K,… --runs N --seed S`** menekan tombol acak (huruf, Backspace, Delete, Enter, Tab, panah,
  Home/End, klik pada tepi teks terlihat) di atas fixture, dengan semua check setelah setiap langkah. Teks dasar diambil
  dari `tests/samples/all-formats.md` dan sampel lain. Bila ada yang gagal, langkah-langkahnya disusutkan (delta
  debugging: buang separuh, lalu seperempat, dan seterusnya, selama kegagalan masih muncul), lalu disimpan sebagai
  repro. Seed membuat setiap run bisa diulang.
- **`test-from FILE`** menulis repro sebagai langkah `step(…)` untuk `tests/electron/visual.mjs` (mockup menyebut
  `editor.mjs`, tetapi tes editor visual ada di `visual.mjs`). Repro-nya disalin ke `tests/electron/repros/`, dan
  langkah itu memuatnya lewat `repro.load(name)`. Langkah tes tetap menekan tombol dan mengklik yang terlihat, jadi
  tetap mengikuti aturan *Drive the editor the way a person does*.

Alur kerja yang dituju, untuk developer maupun agent: muat repro → `press --explain` → baca temuan → perbaiki →
`replay` lulus → `fuzz` di sekitarnya → `test-from`.

## 11. Laporan dari pengguna

Board 3 mockup: Help → *Report a problem with the editor*.

- Dialog mengambil `Recording` tab yang aktif (maksimal 500 transaksi terakhir) dan mengubahnya menjadi repro. `start` adalah
  `base` rekaman, langkahnya adalah input-input itu, dan `actual` adalah keadaan sekarang. Tidak ada `expect`. Gantinya
  adalah catatan pengguna di `note`.
- Pilihan *Blur my text* aktif secara default (bagian 9). Pratinjaunya menampilkan baris kursor yang sudah disamarkan,
  supaya pengguna melihat sendiri apa yang akan tersimpan.
- Pilihan *A picture of the editor* mengambil `capturePage` ketika editor sedang menampilkan teks yang sudah disamarkan.
  Teks itu dipasang di state sementara selama satu frame, lalu state asli dikembalikan. Isi tab yang sebenarnya tidak
  pernah berubah.
- Laporan disimpan di `reports/<tanggal>-<waktu>.mwrepro.json` di dalam `app.getPath('userData')`, bukan di folder
  kerja, supaya tidak ikut ter-commit ke Git pengguna. Renderer tidak bisa menulis berkas, dan kontrak `platform()`
  tidak punya folder data, jadi berkas ditulis oleh main lewat satu IPC baru (`markwork.saveReport(json)` di preload).
  IPC ini hanya menerima JSON repro yang lolos validasi format, dengan nama berkas yang dibuat oleh main. Tombol
  *Show file* membuka foldernya. Tidak ada yang dikirim ke mana pun.
- Teks dialog melewati `_()` (`base/i18n.ts`), karena dialog ini ditujukan untuk pengguna.
- Link "Something looks wrong?" di bawah toolbar muncul setelah Undo atas sesuatu yang baru saja diketik (dalam
  10 detik), karena itu tanda paling umum bahwa editor melakukan hal yang tidak diharapkan. Link ini hilang setelah
  5 detik dan tidak muncul lagi di tab yang sama.

## 12. Keamanan, privasi, dan performa

- **Jembatan tidak pernah ada di build biasa** kecuali app dijalankan dengan flag. Socket hanya bisa dibuka oleh pengguna
  yang sama (`0600`, dan di Linux uid peer diperiksa dengan `SO_PEERCRED` seperti markworkd). Socket ini bisa mengetik
  ke dokumen, jadi perlakukan seperti akses ke jendela itu sendiri.
- **Jembatan tidak memakai port TCP atau `--remote-debugging-port`.** Port CDP memberi kendali penuh atas renderer
  kepada setiap proses lokal, sedangkan jembatan ini hanya membuka perintah di bagian 8.4.
- **Perekam hanya ada di memori** dan hilang bersama tab. Ia tidak pernah ditulis ke disk tanpa dialog bagian 11 atau
  perintah `save-repro`.
- **Performa** (AGENT.md: pemeriksaan performa wajib): ukur waktu `updateListener` dengan dan tanpa `recorder()` dengan
  mengetik 2.000 karakter di `tests/samples/all-formats.md`. Batasnya +0,05 ms per transaksi rata-rata, dan tidak ada
  alokasi sebesar dokumen per transaksi. Pengukuran ini menjadi langkah di `tests/electron/inspector.mjs` yang mencetak
  angkanya, dan angka itu dicantumkan di deskripsi PR.

## 13. Tes alat ini

`tests/electron/inspector.mjs`, didaftarkan di `test:electron:run`:

- `snapshot` atas teks yang diketahui memberi `hidden`, `prefixes`, dan `visibleBefore` yang benar, termasuk teks
  dengan emoji (UTF-16 vs `cp`).
- Setiap check punya satu keadaan yang lulus dan satu keadaan buatan yang gagal. Keadaan gagal dibuat dengan transaksi
  `dispatch` langsung, karena editor yang benar tidak akan menghasilkannya.
- `save-repro` lalu `replay` menghasilkan teks yang sama, dan repro yang disamarkan memiliki offset yang sama.
- `press --explain` lewat socket menghasilkan transaksi dengan `input.key` yang benar.
- Fuzz dengan seed tetap (100 langkah, 1 fixture) berjalan di CI. Fuzz yang lebih panjang dijalankan manual atau terjadwal.
- Build tanpa flag tidak membuat socket, tidak menanggapi `Ctrl+Alt+I`, dan tidak
  menjalankan check, tetapi perekamnya tetap mencatat (laporan pengguna bisa disimpan).

## 14. Tahapan

1. **Perekam, snapshot, checks, dan panel** (Transactions, Decorations, Checks), hanya di mode dev, ditambah langkah
   performa. Tahap ini sudah berguna bagi developer tanpa jembatan. *Sudah dibangun*: sepuluh check, Paused, dan
   sorotan silang (`tests/electron/inspector.mjs`, 13 langkah).
   - **Biaya perekam:** 2.000 transaksi ketik di `all-formats.md` memakan 1,760 dan 1,762 ms per transaksi tanpa
     perekam, serta 1,757 dan 1,798 ms dengan perekam. Bedanya paling banyak 0,04 ms, masih di bawah batas 0,05 ms.
     Angka pertama yang pernah tercatat di sini tidak sah: varian "tanpa perekam" gagal typecheck (import tak terpakai),
     sehingga yang diukur dua kali adalah bundle yang sama.
   - **Temuan pertama `draw-time`, sudah diperbaiki:** `syntaxField` menggambar ulang seluruh dokumen setiap kali
     seleksi berubah, kira-kira 15 ms per gerakan kursor di teks 117 KB. Sekarang setiap gambar menyimpan kunci
     berisi apa saja yang diambilnya dari seleksi (`selectionKey`), dan gambar dipertahankan selama kunci itu tidak
     berubah. Hasilnya, gerakan kursor di teks 117 KB turun dari ±15 ms menjadi ±3,7 ms (median). Check
     `kept-drawing` menjaga kebenarannya, dan detailnya ada di `docs/learn-performance.html` bab 8. Klik pindah
     baris di tampilan live, membuka atau menutup diagram, dan mengetik masih menggambar ulang semuanya. Tes tidak
     mewajibkan `draw-time` diam di sampel panjang karena waktunya bergantung pada mesin.
2. **Jembatan dan `scripts/editor.mjs`**: semua op baca dan bertindak, `--headless`, dan format repro (`save-repro`,
   `load`, `replay`). Mulai dari tahap ini agent bisa bekerja. *Sudah dibangun*: `electron/inspect.ts`,
   `renderer/lib/inspect/bridge.ts` dan `repro.ts`, serta `npm run editor` (`tests/electron/inspector.mjs`, 9 langkah
   baru). Yang berbeda dari rancangan di atas:
   - **Perekam mendengar tombol dan klik di `window`** (fase capture), bukan lewat `domEventHandlers`. Tabel perintah
     (`App.tsx`) mengambil tombolnya di `document` lalu menghentikannya, dan CodeMirror tidak meneruskan event dari
     widget yang mengedit dirinya sendiri (sel tabel). Tanpa itu, Ctrl+B dan ketikan di sel tabel tidak punya `input`,
     sehingga repro memutarnya ulang sebagai perubahan, bukan sebagai tombol.
   - **Tidak ada pemeriksaan uid peer.** Node tidak membuka `SO_PEERCRED`. Batasnya hanya folder `0700` dan socket
     `0600`, dan di Windows named pipe dengan ACL bawaan.
   - **`log --follow` bertanya ulang setiap 250 ms** (`log --since N`), bukan menerima push `{"ev":"tx"}`.
   - **Beberapa op dalam satu panggilan** dipisah `--then` (`--headless open a.md --then press End x`), karena
     `--headless` menutup jendelanya ketika skrip selesai.
   - **`--headless` bekerja pada salinan folder** (`--folder` disalin ke folder scratch). Tombol yang dikirim mengubah
     teks, dan autosave akan menuliskannya ke folder asli. Di Linux ia menambah `--no-sandbox` bila helper sandbox
     Chromium tidak terpasang setuid root (container, `npm install` baru), seperti yang juga dilakukan Playwright di tes.
   - **Tombol memakai nama DOM**, dengan `Mod` untuk Cmd di macOS dan Ctrl di sistem lain, sama seperti `Mod-` di
     CodeMirror. `Ctrl` selalu berarti tombol Control.
   - **Langkah repro dari rekaman:** tombol yang hanya mengetik digabung menjadi `type`, klik menjadi `{ click: { pos } }`
     (posisi kursor sesudahnya; rekaman tidak menyimpan teks terlihat yang diklik), dan transaksi tanpa input dalam
     100 ms setelah input dianggap bagian dari input itu. Transaksi lain tanpa input menjadi `select` (bila hanya seleksi)
     atau `external`. Repro yang tidak punya check gagal mendapat `expect.doc`, sehingga `replay`-nya menjadi tes bahwa
     teksnya keluar sama.
   - **Sudah ditambahkan kemudian** (bagian 14, *Sesudah tahap 4*): `--cp`, serta `around`, `visibleAfter`, `widgets`,
     `parse`, dan `parseMs` di snapshot.
3. **Fuzz, penyusutan, dan `test-from`**, ditambah fuzz dengan seed tetap di CI. *Sudah dibangun*: `scripts/editor-fuzz.mjs`
   (dipakai `npm run editor -- fuzz`), `test-from`, dan `tests/electron/repros.mjs`. Yang berbeda dari rancangan:
   - **Repro yang disimpan diputar oleh `repros.mjs`,** bukan disalin menjadi `step(…)` di `visual.mjs`. `test-from`
     menyalin repro ke `tests/electron/repros/` dengan `expect.checks: "pass"` (dan `expect.doc` bila ada), dan
     `repros.mjs` memutar setiap berkas di sana lewat `replay` dengan semua check. Repro tetap menekan tombol sungguhan,
     jadi aturan *Drive the editor the way a person does* tetap berlaku. Repro pertama di sana adalah aturan lama dari
     AGENT.md: Backspace di awal baris setelah code block memilih bloknya, tidak menggabungkan baris dengan fence.
   - **Langkah acak** diambil dengan bobot: huruf dan spasi, Backspace, Delete, Enter, Tab, Shift+Tab, panah, Home/End, dan
     klik pada posisi acak (`--keys` membatasinya). Klik pada tepi teks terlihat ditambahkan kemudian (bagian 14,
     *Sesudah tahap 4*).
   - **Penyusutan** adalah delta debugging yang disederhanakan: buang satu dari n potongan selama check yang sama masih
     gagal, perkecil potongannya bila tidak ada yang bisa dibuang, sampai satu langkah pun tidak bisa dibuang atau
     waktunya (`--shrink-seconds`, 120 detik) habis.
   - **`--quiet MS`** (60 ms untuk fuzz, 500 ms bila tidak diberi) memendekkan tunggu "editor sudah tenang" setelah
     setiap langkah. 100 langkah memakan sekitar 10 detik.
   - **Fuzz di CI:** satu run 100 langkah dengan seed 1 atas `all-formats.md` di `inspector.mjs`. Penyusutannya diuji
     dengan koneksi palsu yang gagal hanya bila dua langkah tertentu ada, karena editor saat ini lulus semua check.
   - **Temuan pertama fuzz, sudah diperbaiki.** 4 seed × 50 run × 500 langkah atas semua sampel (`--seed 11` sampai `14`,
     ±97.000 langkah) menghasilkan 8 kegagalan `backspace-visible`, semuanya pada gambar:
     - Delete tepat sebelum gambar di baris item daftar menghapus satu huruf markup-nya. Range tersembunyi gambar
       bertumpuk (seluruh `![…](…)` di atas `![` dan `](…)`), dan `pastHidden` di `visual.ts` hanya melompati yang pertama.
       Sekarang ia melompat ke ujung terjauh. Selain itu, tombol yang memilih objek (`pickingKeys` di `blockselect.ts`)
       kini didahulukan (`Prec.high`) dari Backspace/Delete milik `visual.ts`.
     - Di teks tanpa berkas, gambar beralamat relatif tidak punya gambar (alamatnya tidak bisa ditentukan), tetapi
       markup-nya tetap disembunyikan, sehingga gambar itu hilang dari layar dan tombol di sekitarnya mengubah teks yang
       tidak terlihat. Sekarang ia digambar sebagai gambar yang hilang (teks alt), dan bisa dipilih serta dihapus utuh.
     - Klik acak pada tempat yang tidak digambar menghentikan run (seed 13). Klik itu sekarang dilewati.
     Repro yang tersisa dari temuan pertama ada di `tests/electron/repros/`; yang kedua diuji di `visual.mjs`.
4. **Laporan pengguna** (dialog, penyamaran, screenshot, i18n) dan `traced`/`trace` di titik keputusan `visual.ts`,
   `blockselect.ts`, dan `tables.ts`. *Sudah dibangun*: `markdown/blur.ts`, `inspect/report.ts`,
   `components/ReportProblem.tsx`, perintah `report-problem` (Help dan palet), IPC `report-picture`/`report-save`/
   `report-show` di `main.ts`, `save-repro --blur`, serta `traced`/`handling`/`trace` di `recorder.ts`
   (`tests/unit/blur.ts`, 7 tes; `tests/electron/inspector.mjs`, 4 langkah baru dan 1 langkah yang diperluas). Yang
   berbeda dari rancangan:
   - **Teks dialog tidak melewati `_()`.** Renderer tidak punya terjemahan: `scripts/layers.mjs` hanya mengizinkan
     renderer mengambil nilai dari `markdown/`, pesan `app/protocol/`, dan `app/commands.ts`, dan semua teks renderer
     lain juga ditulis langsung dalam bahasa Inggris. Yang diterjemahkan hanya nama perintahnya di tabel perintah
     (`_('Report a Problem with the Editor…')`). Terjemahan dialog menunggu cara renderer menerjemahkan.
   - **Pilihan rekaman.** Mockup menulis "The last 2 minutes of editing". Karena batasnya sekarang 500 transaksi,
     pilihannya menjadi *What the editor just did* dengan jumlah perubahan yang tersimpan. Bila dimatikan, `start`
     adalah teks sekarang dan tidak ada langkah.
   - **Aturan penyamaran yang sebenarnya.** Tanda baca memang tidak pernah diganti, jadi yang perlu dijaga dari parse
     hanya bahasa fence dan skema URL. Di luar itu dijaga juga awalan baris (`RE.quote`, `RE.list`: nomor daftar dan
     `[x]`) dan kunci field (`findSegments`: `[due::`). Kata di dalam sintaks tersembunyi ikut disamarkan: target
     `[[catatan]]`, teks alt gambar, dan alamat tautan selain skemanya. Huruf Latin beraksen (é, ü) disamarkan karena
     termasuk huruf Latin dan lebarnya tetap satu unit UTF-16.
   - **Gambar diambil oleh main dan disimpan di sana sampai laporan disimpan.** Renderer meminta `report-picture`
     dengan kotak editor saat editor menampilkan state tersamar (`view.setState`, dua frame, lalu state asli
     dikembalikan) dan dialognya disembunyikan. State baru digambar dari atas, jadi posisi scroll dikembalikan dengan
     `view.scrollSnapshot()` lewat transaksi berisi efek saja yang ditandai `unrecorded`, sehingga tidak masuk rekaman.
     Mengatur `scrollTop` langsung tidak cukup, karena CodeMirror mengukur ulang tinggi baris sesudahnya. `report-save` lalu menulis repro dan PNG-nya berdampingan, dan repro
     mendapat field `picture` berisi nama PNG itu. Renderer tidak pernah mengirim byte gambar.
   - **Tombol perintah tidak berjalan selama dialog terbuka.** Dialog ini bukan dialog core (`dialog`), jadi tabel
     perintah di `App.tsx` juga berhenti saat `info === 'report'`. Tanpa itu, Ctrl+Z di kolom catatan membatalkan teks
     yang sedang dilaporkan.
   - **Laporan tidak punya `expect`.** `reproOf` memberi `expect` bila tidak ada check yang gagal, tetapi di build biasa
     tidak ada check yang berjalan, jadi `reportOf` membuangnya.
   - **Link "Something looks wrong?"** muncul di bawah toolbar format pane yang fokus. "Tab yang sama" dihitung per
     rekaman, jadi tab yang teksnya diganti core (rekaman baru) bisa menawarkannya lagi.
   - **Nama handler:** `visual.backspace`, `visual.delete`, `pick.before`, `pick.after`, `picked.remove`,
     `picked.leave`, `picked.line-after`, serta `table.cell-input`, `table.step`, dan `table.leave` lewat
     `handling()` (sel tabel ditangani event DOM, bukan perintah CodeMirror). `trace()` hanya mencatat di dalam handler
     yang dilacak, dan catatannya dibuang bila handler itu tidak membuat transaksi. Di luar mode dev keduanya hanya
     memeriksa satu boolean; kalimat untuk `trace()` tetap disusun, sekali per tombol yang ditangani.
   - **Biaya:** 2.000 transaksi ketik di `all-formats.md` tetap ±1,4 ms per transaksi di build biasa (1,388 dan
     1,474 ms sesudah, 1,410 ms sebelum, satu run masing-masing; selisihnya sebesar derau antar-run). Penyamaran `all-formats.md`
     (5.842 karakter) memakan ±6 ms. Itu terjadi sekali saat dialog dibuka (pratinjau) dan beberapa kali saat laporan
     disimpan (teks awal, teks sekarang, dan state untuk gambar), tidak pernah saat mengetik.

**Sesudah tahap 4: yang tersisa dari rancangan.** *Sudah dibangun*, di PR tersendiri:

- **Snapshot lengkap.** `around` (teks baris kursor di kedua sisinya, sampai 24 karakter), `visibleAfter`, `widgets`
  (dekorasi yang menggambar sesuatu sebagai ganti teks), `parse` (gaya baris kursor dari parse, dalam UTF-16 dari awal
  baris), dan `parseMs` (waktu parse teks ini; 0 bila parse sebelumnya dipakai ulang, `parseMsOf` di `editor.ts`).
  `visibleBefore` tetap di tingkat atas, tidak di dalam `around`, karena tes dan skrip sudah membacanya di sana.
- **`--cp`** adalah opsi global `editor.mjs`. Dengan opsi itu, `snapshot`, `decorations`, `click --pos`, dan `select`
  menerima dan menjawab code point (`cpSnapshot` di `snapshot.ts`). Tanpa opsi itu, posisi tetap UTF-16 dan
  `cursor.cp` ditambahkan bila nilainya berbeda. `log` dan repro tetap UTF-16, karena di sana posisi milik `changes`
  CodeMirror.
- **Klik di tepi teks terlihat.** Ada langkah repro baru `{ "click": { "line": N, "edge": "start" | "end" } }` dan
  `click --line N [--start|--end]`. Klik jatuh tepat di dalam huruf pertama yang terlihat di baris itu, atau 30 px
  sesudah hurufnya yang terakhir (pada baris tampilan terakhir bila baris itu terbungkus), seperti `textEdges` di
  `visual.mjs`. Baris yang tidak digambar sebagai baris teks (di dalam kotak kode, tabel, atau fence tersembunyi)
  menjawab `not-found`, dan fuzz melewatinya. Di fuzz, `click` sekarang jenis ini (bobot 6), sedangkan klik di posisi
  menjadi `click-pos` (bobot 2).
- **Tab Replay & test** (`components/InspectorReplay.tsx`): *Open Repro…* (berkas apa pun, termasuk laporan
  pengguna, dibaca lewat `<input type="file">`), *Replay This Recording*, *Step ▶*, *Play All*, dan *Restart*, dengan
  daftar langkah dan hasilnya (`pass`, `fail` beserta langkah dan check pertama, atau `differs`), seperti `replay`.
  Ada juga *Copy as JSON*, *Save Repro…*, dan *Make a Test* (seperti `test-from`, ke `tests/electron/repros/` checkout
  tempat app berjalan; `MARKWORK_TEST_REPROS` untuk tes). Langkah diputar sebagai input sungguhan oleh main, lewat IPC
  baru `inspect-run` (hanya mode dev) yang menjawab op yang sama dengan socket, ditambah `play`, `save-repro`, dan
  `keep-test`. `stepRequest` dan `keptAsTest` ada di `repro.ts`, salinan TypeScript dari yang dipakai CLI.
- **Detail transaksi** mendapat *Show the State Before* (Paused pada transaksi sebelumnya), *Make a Test from This*
  (pindah ke Replay & test dengan rekaman yang tampil), dan *Copy as JSON* (`entryJSON`, sama dengan `log`). Header
  panel mendapat *Copy Snapshot*.
- **`shrink FILE`** di CLI menyusutkan repro yang sudah ada sampai langkahnya paling sedikit sambil check-nya tetap
  gagal (`--check`, atau check pertama di `actual.failed`; 600 detik bila tidak diberi). Gunanya untuk laporan
  pengguna yang berisi ratusan langkah, dan untuk temuan fuzz yang waktu penyusutannya habis.
- **Temuan pertama klik di tepi teks, sudah diperbaiki.** 2 seed × 20 run × 300 langkah atas semua sampel
  (`--seed 21` dan `22`, ±12.000 langkah) menghasilkan 1 kegagalan `backspace-visible`. Delete pada huruf pertama
  teks judul (`## a Emphasis`) membuat spasi sesudahnya ikut masuk ke prefix tersembunyi (`##  `), sementara kursor
  tetap di posisinya, yaitu di dalam prefix itu. Delete berikutnya lalu menghapus spasi yang tidak terlihat. Backspace
  pada huruf pertama berperilaku sama. Sekarang `textStartAfter` di `visual.ts` memindahkan kursor ke awal teks yang
  baru (panjang prefix dari `lineKindOf` di `markdown/editcommands.ts`), Delete dari kursor yang tertinggal di dalam
  prefix bekerja dari ujung prefix, dan `prefix-guard` juga memeriksa kursor sesudah penghapusan, tidak hanya sesudah
  kursor bergeser. Repro-nya ada di `tests/electron/repros/` (`delete-first-letter-of-a-heading`,
  `backspace-first-letter-of-a-heading`). Penyusutan otomatis hanya sampai 136 dari 213 langkah dalam 25 menit,
  karena setiap percobaan memutar ulang ratusan langkah. Penyebabnya ditemukan dengan membaca `log` dan `snapshot`
  dari jendela yang dibiarkan hidup (`--headless --keep`).
- **Socket yang tertinggal.** Jendela yang dimatikan tanpa ditutup (oleh tes, atau `kill`) meninggalkan socket-nya di
  folder runtime. `electron/inspect.ts` sekarang menghapus socket milik pid yang sudah tidak ada saat mulai.
- **Bug yang ditemukan saat membangunnya:** tombol `Ctrl+Alt+I` tercatat sebagai langkah transaksi berikutnya,
  sehingga *Replay This Recording* menutup panelnya sendiri. Sekarang `App.tsx` membuang input itu dari perekam
  (`forgetInput`).

Setiap tahap adalah satu PR beserta testnya, dan README diperbarui (pintasan dan perintah palet) di tahap 1 dan 4.

## 15. Pertanyaan terbuka

Tidak ada lagi. Dua pertanyaan sebelumnya sudah diputuskan (lihat *Keputusan*):

1. **Emoji dan aksara non-Latin dalam penyamaran:** dibiarkan apa adanya untuk saat ini. Bila teks non-Latin yang
   ikut terbaca menjadi masalah, jalan tengahnya adalah mengganti dengan karakter lain yang lebar UTF-16 dan
   kategorinya sama.
2. **Ukuran rekaman:** 500 transaksi cukup. Batas 2 menit dibuang, sehingga bug yang baru disadari belakangan
   (misalnya bold yang rusak dan baru terlihat setelah scroll) tetap ada di rekaman selama belum lewat 500 transaksi.

Catatan untuk contoh di mockup: bug "Backspace menghapus `*` tersembunyi" hanya ilustrasi. `pastHidden` di `visual.ts` sudah
melompati range yang berakhir tepat di kursor, jadi kasus persis itu seharusnya lulus. Contoh itu dipilih karena
bentuknya mirip bug yang pernah terjadi (Backspace yang menggabungkan baris dengan fence penutup).
