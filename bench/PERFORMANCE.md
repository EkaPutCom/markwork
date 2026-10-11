# Measurement of the editor optimizations — 4 October 2026

A comparison of the baseline stored at commit `a7e4444` with the results of the optimizations
in the same environment: the same GJS/GLib/GTK, the X11 backend under Xvfb, 10
repetitions after warm-up, GUI sizes of 25/50/100 blocks. The numbers are the results of a
synthetic benchmark on this machine, not a guarantee for every device/document.

## A document of 100 blocks (~30 KB)

Medians in milliseconds; the last column is the drop in time.

| Operation | Before | After | Drop |
| --- | ---: | ---: | ---: |
| setText + highlight + layout | 412.15 | 360.74 | 12% |
| highlight() again | 20.19 | 1.04 | 95% |
| type per character | 20.85 | 2.55 | 88% |
| large paste + Unicode | 189.36 | 166.45 | 12% |
| delete large text | 42.54 | 4.70 | 89% |
| undo large paste | 43.24 | 4.54 | 90% |
| redo large paste | 210.02 | 187.16 | 11% |

The latency of typing per character: p95 30.14 → 10.32 ms;
the sample maximum 77.45 → 22.78 ms.
The raw samples and the metadata of the new results are stored in [baseline.json](baseline.json).

In the follow-up run after range parsing, the median of typing went down from 4.91 to
2.55 ms and re-highlighting from 4.84 to 1.04 ms. Some operations were recorded as
slower than in the previous cache stage: opening the text 283.13 → 360.74 ms,
paste 138.60 → 166.45 ms, redo 154.28 → 187.16 ms, and moving the cursor
20 lines 123.63 → 185.87 ms. At 50 blocks, moving the cursor also rose
61.11 → 151.04 ms. This run has not yet separated environment noise from a regression;
those numbers need to be investigated before declaring that all interactions are comfortable.

## Changes

- Reuse the parsing results of lines that did not change, with relative offsets.
  An edit only reads the buffer lines that changed and parses the range up to the
  safe code/table context boundary. A new code fence widens the range if needed.
  The word/character count is updated from that range, without joining the whole text.
- Keep the table tags/code colors when text outside a block is edited. GTK already
  shifts the tags along with text changes; the table widgets still get their position updated.
- Cancel a queued highlight when `setText()` already highlighted directly, and merge
  adjacent tag ranges when applying a tag to many lines at once.
- Update only the changed part of the outline; a shift in line numbers does not rebuild
  the labels. This also reduces the pause when a heading becomes a paragraph.
- The inline parser makes a copy of the characters/string only when the masking changes.
  Counting code points no longer makes an array of characters for the whole text.

## Validation and the limits of coverage

The tests compare the cache with a fresh parser after changes of the code/table context,
Unicode, undo/redo, and deleting text. The tests also check one callback after
`setText()`, code coloring after the offset shifts, outline reuse,
and a grid click after the lines shift. The test suite includes the kanban mouse on Xvfb: **224 passed, 0 failed**, with no
critical warnings in the last log check. The typecheck and the diff check also passed.

An additional test compares 200 sequences of random edits with the full parser,
including tags and Unicode offsets. On 50,000 lines without blank lines, one edit
only does one buffer read of less than 100 characters and parses at most
four lines. This is evidence of the parsing coverage, not a measurement of GUI latency.
An edit inside a code/table block re-parses the related block; a changed fence
can widen it up to the end of the document. The offset/metadata arrays and the tag
checks still need work proportional
to the number of lines.

The extreme test of 500 blocks (~148 KB, 500 table grids) still triggers GJS callbacks that
are blocked during GC and has not produced a complete valid measurement. Attempts to
change the loop, force GC, and keep widget references did not solve it and are not
in the final change. Do not assume this case is responsive. The GUI benchmark
process is now limited to 120 seconds (`--timeout=...`) so that a hang is detected and a
partial result does not become a baseline. A test with a 1 second time limit produced exit code
1 and did not save the JSON.

Asynchronous image/diagram rendering and the latency of kanban interactions are not covered by the
benchmark. The correctness checks of those features remain in the GUI test suite.

The `long` fixture also tests 20,000 lines (~1.3 MB) without table grids. The GUI measurement
after the parsing change still met GJS callbacks that were blocked during GC and
did not save a partial baseline. That result does not prove a comfortable GUI latency
for a document of this size.

## Autosave (2026-10-04)

The new scenario `autosave (write file)` measures `MainWindow.autosave()`: writing the whole
document to disk after one keystroke. The `changed` handler only records the time; the timer is not
recreated per keystroke, so `type per character` did not change meaningfully. The results
(Xvfb, 10 repetitions): the `mixed` fixture median 4.0/4.9/5.6 ms (7/15/30 KB), p95 up to
38 ms; the `long` fixture median 3.5/3.6/3.9 ms (16/32/64 KB), p95 up to 24 ms. The p95
spikes come from the synchronous file write on the main thread and happen once per
typing pause, not per keystroke. The other scenarios in `bench:compare` stayed within the
noise range (e.g. `delete large text` at 7 KB fluctuated 11–14 ms between runs). The baseline
was not updated; the new scenario has no comparison yet. Documents of ≥1 MB were not measured.


## Writing a book (2026-10-04)

The new fixture `book` imitates a novel manuscript: long one-line paragraphs that the editor wraps,
dialogue, quotes, `*italic*`/`**bold**`, a chapter every 10 scenes. 400 blocks ≈ 651 KB ≈ 100,000 words
(the size of a novel in one file). New scenarios: `open: longest pause` (the longest main loop
pause from setText until GTK finishes laying out, which is what feels like freezing),
`type via view (paragraph)` (the TextView keybinding signal at the end of a long paragraph, the same path
as a real key press), `Enter new paragraph`, and `background autosave (main thread)`.

Before/after at 651 KB (Xvfb, 10 repetitions, median; p95 in parentheses). The "before" column
was measured with the `src/` code of commit `ce74a34` and the same bench.

| Operation | Before | After |
| --- | ---: | ---: |
| open: longest pause | 668.9 (671.0) | 162.4 (171.2) |
| setText + highlight + layout | 1434.1 | 761.1 |
| type per character | 2.91 (5.99) | 1.82 (5.00) |
| type via view (paragraph) | 3.53 (12.94) | 2.61 (11.59) |
| Enter new paragraph | 6.05 (14.81) | 3.25 (12.62) |
| move cursor 20 lines | 24.01 | 11.93 |
| autosave, the main thread part | 9.59 (17.07)¹ | 5.33 (7.46) |

¹ Before, autosave wrote and fsynced synchronously. On the NVMe of this machine it is only about 4 ms,
but on a slow or busy disk the fsync can take tens of milliseconds, right when the user keeps typing.

On mixed 100 blocks (`bench:compare`): type per character 2.55 → 1.39 ms, setText 360.74 →
227.23 ms, move cursor at 50 blocks 151.04 → 71.80 ms; the other scenarios within the noise range.
`markdownToHtml` was once recorded at +37% in one run, even though `src/markdown/` did not change;
three reruns gave 7.2–8.0 ms (baseline 7.26 ms), so that was noise.

### Causes and fixes

- **Opening a document froze for about 0.6 seconds.** GTK 3 gives a height of 0 to lines that have not
  been laid out. The first draw after `set_text` (the TextView pixel cache draws half a screen
  extra; `bottom_margin` lengthens the canvas) covers the area below the lines that are already laid out,
  so `gtk_text_layout_draw` lays out all the lines up to the end of the document at once. Proven
  with a plain TextView (without Markwork code): a `bottom_margin` of just 1 px is enough to trigger it.
  `replaceAllText()` zeroes the scroll and then queues a scroll to the cursor, so GTK first
  lays out the two screens around the cursor and the rest in the background. The remaining 162 ms is the
  synchronous full highlighting (once on opening). An experiment to temporarily remove `bottom_margin`
  was rejected: `set_bottom_margin()` makes GTK lay out the whole document again, and pasting 12 KB
  into a 650 KB manuscript became more than 1 second of background work.
- **The hidden markers were computed for all lines on every keystroke/cursor move** (about 1 ms and
  thousands of new arrays at 650 KB). Now `MarkerConcealer` only checks the old/new active lines,
  the re-parsed lines, and the lines that are not known yet.
- **Merging the highlighter cache** made several copies of arrays the size of the document and one new
  tuple per marker after an edit (about 1 ms). Now it is one copy per array, a binary search,
  and an in-place shift (about 0.4 ms).
- **The outline** made a JSON string of all headings on every keystroke; now they are compared directly.
- **Autosave** from the timer writes through Gio on a worker thread; the next synchronous write
  to the same path waits for the background write (its test makes sure the old contents do not overwrite the new).

### The limits of the measurement

The bench measures until the main loop is idle (highlighting and layout), not including
drawing to the screen. On Xvfb without a window manager, the `draw` signal of the TextView does not always appear,
so the drawing time cannot be measured reliably; the p95 spike of about 10–12 ms in `type via view`
also appears at 50 blocks (not proportional to the document length) and matches a frame clock
that draws in the middle of the measurement. The full highlighting on opening is still proportional to the length of the
document; documents of ≥1 MB and documents with very many tables (moving the cursor about 7 ms per
line on mixed 100 blocks, from the table layer) have not been optimized.

Baselines: [baseline.json](baseline.json) (mixed, the default of `bench:compare`) and
[baseline-book.json](baseline-book.json); compare a book manuscript with
`gjs -m dist/bench.js --fixture=book --size=400 --sizes=50,200,400 --timeout=400 --compare=bench/baseline-book.json`.

## Incremental highlighting on opening (2026-10-04)

A profile of opening a 650 KB manuscript that differs from the previous document (the outline is
rebuilt too): GTK `set_text` 29 ms, parsing 31 ms, syntax tags of the whole buffer 60 ms, an outline of
440 lines 54 ms, hidden markers 33 ms, so about 207 ms were held up. The scenario
`open: longest pause` now alternates between two documents with different headings so that the
cost of the outline is measured too (before, the same document was opened again and the outline did not change).

The change: the syntax tags and the hidden markers are only applied to the first 200 lines; the rest is
done in installments of ≤8 ms in an idle with a priority between drawing (120) and the GTK background layout (125),
prioritizing the lines around the cursor and the visible ones. The outline is built 50 lines per turn. Parsing stays
full and synchronous.

The results (median, Xvfb, 10 repetitions; "before" = the baseline of commit `472c298`, the old scenario
that opened the same document, so the drop is actually larger):

| Document | open: longest pause before | after |
| --- | ---: | ---: |
| book 81 KB | 18.47 | 13.01 |
| book 325 KB | 70.99 | 34.49 |
| book 651 KB | 162.41 | 71.45 (p95 79.50) |
| mixed 30 KB | 134.41 | 46.75 |

The other scenarios are within the noise range. The cost: the total until all the tags are applied and GTK finishes
laying out rose by about 10% (book 651 KB: 761 → 820 ms) because the work is done in installments, and `highlight() again`
without edits 0.41 → 0.6–0.9 ms because of the deferred line checks; neither is
felt while typing. What remains of the opening pause is GTK `set_text` and the full parsing.

## Moving the cursor in a document with tables (2026-10-04)

The table layer now changes tags only on the tables that switch between a grid and raw
text when the cursor/selection moves. It no longer walks the tag ranges of all the tables
or makes a signature string of all the tables on every move. The calculation of the
`get_line_yrange()` position is limited to the visible grids: grids off screen are
hidden, their space is kept by tags, and their position is updated when the
scroll changes. Before, asking for the position of all the grids forced GTK to lay out
lines far off screen after the height of one table changed.

Measurements before/after in the same session, the `mixed` fixture, X11/Xvfb,
GJS 1.80.2, GTK 3.24.41, 10 repetitions after warm-up. All numbers in ms;
p95 and maximum are the same because this scenario only has 10 samples.

| Document | Median before → after | p95 before → after | Maximum before → after |
| --- | ---: | ---: | ---: |
| mixed 7 KB, move cursor 20 lines | 44.29 → 19.30 | 49.88 → 26.45 | 49.88 → 26.45 |
| mixed 15 KB, move cursor 20 lines | 66.66 → 27.50 | 78.25 → 32.29 | 78.25 → 32.29 |
| mixed 30 KB, move cursor 20 lines | 132.52 → 29.59 | 150.00 → 42.65 | 150.00 → 42.65 |

For mixed 30 KB, the median dropped 78% against the measurement before in this session,
or 80% against the stored baseline (145.26 ms, p95/maximum 155.38 ms).
Type per character stayed 1.47 → 1.51 ms (p95 5.98 → 5.79, maximum 23.42 → 15.27).
Delete large text 4.43 → 2.77 ms, undo 3.96 → 3.05 ms.

There are rises that are recorded: the total of opening mixed 30 KB 245.42 → 264.53 ms
(p95/maximum 271.92 → 285.35), paste 135.67 → 148.99 ms
(p95/maximum 180.92 → 162.10), and redo 155.49 → 165.72 ms
(p95/maximum 216.64 → 174.14). The initial creation of all the grids and the tag synchronization
after edits are still done; this optimization focuses on moving the cursor.
The results of intermediate stages that ran together with the GUI tests are not used for the final numbers.
The old baseline is kept so that these rises stay visible in `bench:compare`.

Validation: `npm test` **383 passed, 0 failed**, including the checks that the tags of other
tables are not touched, a selection across tables, widget reuse, and scrolling to the
last grid and back without changing the document height. The whole log was checked, with no
runtime warnings/errors. The typecheck and the diff check passed. Screenshots of the light and dark
themes were checked while both tables alternated between raw text and
back to a grid; the grid and the paragraphs do not overlap. `test:ui` on the desktop was not
run because the displayed test mode was not requested (the test environment rule of
AGENT.md); the mouse tests were run on Xvfb. The extreme case of 500 grids and a document of
20,000 lines were not measured again; this fix does not prove the GC problem in
those cases is solved.

The regression check of the `book` fixture also finished for 50/200/400 blocks, 10
repetitions, the same X11/Xvfb and baseline environment. On the 651 KB book:

| Operation | Median baseline → after | p95 baseline → after | Maximum baseline → after |
| --- | ---: | ---: | ---: |
| move cursor 20 lines | 14.67 → 13.69 | 17.09 → 16.68 | 17.09 → 16.68 |
| type per character | 2.03 → 2.08 | 4.65 → 4.99 | 15.46 → 16.07 |
| open: longest pause | 71.45 → 72.25 | 79.50 → 81.41 | 79.50 → 81.41 |
| setText + highlight + layout | 820.16 → 843.38 | 869.32 → 889.24 | 869.32 → 889.24 |

The main book changes are within ±7% of the median; there is no evidence of a significant regression
for the cursor/typing yet. This is a comparison against the stored baseline, not a new
measurement before for the book fixture. The mixed and book benchmark logs are clean. The measurement
still goes until the main loop is idle, not the full duration of drawing to the screen.

A separate rerun of mixed 100 blocks (10 repetitions, the same environment) confirmed:
cursor median **29.06 ms**, p95/maximum **41.24 ms**; setText median **260.76 ms**,
p95/maximum **292.79 ms**; paste median **146.02 ms**, p95/maximum **159.53 ms**.
So the cursor fix is consistent, while the rise of the total of opening of
about 7–9% against the stored baseline remains visible and is not removed by
replacing the baseline. This rise is small but has not been separated between the cost of
hiding the initial grids and environment noise. The log check of the rerun is also clean.

## Creating table grids on opening (2026-10-04)

A full grid is now created when a table enters the screen. Two GTK measuring cells
use the same CSS to provide the height of the table before the grid is created;
the size and the markup are stored on the active block. The shared cache is limited to 256 tables,
1,024 cells, and 1 Mi UTF-16 key units each. A width change reuses
cells with ellipsize, so it does not take the grid apart or reapply
the height tags. A palette change clears the measurement results. Incremental highlighting
also no longer trusts a range of thousands of lines that are considered visible before
GTK validates the line heights.

The first-opening comparison uses three separate GJS/Xvfb processes per variant,
one new window per process, 500 blocks of the mixed fixture, and then `setText` again with the same contents.
The different variant replaces one cell in each table. The source before
is `tablelayer.ts` and `view.ts` at HEAD `7080c4e`; the source after is the
working tree of this change. GJS 1.80.2, GTK 3.24.41, X11/Xvfb, host c640.
A 1 ms main loop timer measures the longest pause; the total goes until GTK is idle and
highlighting is done, not until all the pixels of the screen are drawn.
GC was called before the measurement. The raw samples along with the number of calls are in
[table-opening-profile.json](table-opening-profile.json). The method times are
inclusive, so they must not be summed.

All numbers are ms. For three samples, the p95 by nearest rank is the same as the maximum;
these small samples are a diagnosis, not an estimate of the production distribution.

| Scenario | Median before → after | p95/maximum before → after |
| --- | ---: | ---: |
| 500 identical tables, first open: total | 8249.69 → 2019.03 | 8274.09 → 2044.20 |
| 500 identical tables, first open: pause | 1916.57 → 256.49 | 1931.16 → 262.93 |
| 500 different tables, first open: total | 8304.25 → 2153.29 | 8643.93 → 2158.40 |
| 500 different tables, first open: pause | 1927.89 → 353.56 | 1963.84 → 364.34 |
| 500 identical tables, reopen: total | 3395.40 → 1699.07 | 3415.86 → 1725.12 |
| 500 identical tables, reopen: pause | 641.19 → 556.91 | 660.89 → 577.63 |
| 500 different tables, reopen: total | 3400.55 → 1702.07 | 3503.12 → 1823.32 |
| 500 different tables, reopen: pause | 641.82 → 572.32 | 645.41 → 581.96 |

In both variants, the first open creates **1 grid** for the 1 visible table,
before it was 500 grids. The `build` calls went down **1000 → 1**: the old implementation
built all the grids again when the initial width of 700 changed to 781 px.
The total of the first open went down 76% for identical tables and 74% for different tables.
A widget that has been visible is still reused; this does not yet limit the number of
widgets after the user scrolls through the whole document.

The GUI benchmark of mixed 500 blocks after warm-up finished all
14 operations with 10 repetitions, with the results in [tables-500.json](tables-500.json).

| Operation | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| setText + highlight + layout | 1679.04 | 1827.03 | 1827.03 |
| open: longest pause | 605.28 | 741.70 | 741.70 |
| type per character | 3.91 | 10.29 | 18.71 |
| type via view | 14.90 | 25.86 | 28.77 |
| Enter paragraph | 12.45 | 14.44 | 14.44 |
| large paste + Unicode | 157.20 | 168.30 | 168.30 |
| delete large text | 5.40 | 6.46 | 6.46 |
| undo large paste | 5.09 | 6.75 | 6.75 |
| redo large paste | 177.00 | 191.11 | 191.11 |
| move cursor 20 lines | 27.76 | 42.95 | 42.95 |

This whole process takes about **198 seconds**, using a diagnostic subprocess limit of
900 seconds and `--child` to skip the limit of the parent runner. The old run
limited to 180 seconds that stopped halfway was not used as a baseline.
So the fix of grid creation is proven, but the pause of reopening of about
0.6 seconds and the length of the 500-block series still need to be addressed; this is not
evidence that the whole freeze/GC or timeout problem is solved.

The full `npm run bench:compare` was run twice, without GUI tests at the same time.
On mixed 100 blocks, the total was 229.44/213.61 ms, the pause 40.00/43.74 ms, and typing
1.24/1.51 ms per character. The older cursor baseline already predates the earlier
cursor optimization; the drop in the cursor against that baseline must not be
attributed entirely to this change. Variation is still visible: mixed 25
paste 200.45 and then 158.80 ms (baseline 134.21), type via view 3.75 and then
2.98 ms (baseline 1.95), while mixed 50 redo reached 203.44 ms on the
rerun (baseline 151.07). The pure Markdown module did not change, but
`markdownToHtml` also shifted 10.27 → 8.35 ms and `findTables` 0.43 → 0.27 ms;
this shows environment variation, not a reason to remove the rise in the GUI operations.

The book fixture was fully checked at 50/200/400 blocks, 10 repetitions
each. On the 651 KB book, the median/p95/maximum of the opening pause were
**65.78/79.59/79.59 ms**, and typing **1.87/4.76/15.09 ms** per character.
The rises against the stored baseline are still recorded: the total of opening
820.16 → 904.69 ms (p95/maximum 869.32 → 944.62), Enter
3.35 → 5.05 ms (p95/maximum 11.59 after), and redo
165.55 → 183.47 ms (p95/maximum 196.63 after). This does not yet prove
an improvement of the total of opening a document without tables.

The long fixture of 2,000 blocks (~1.3 MB) was measured before/after in sequence,
three repetitions each, not only compared with the historical baseline:

| Operation | Median before → after | p95/maximum before → after |
| --- | ---: | ---: |
| setText + highlight + layout | 1925.10 → 2031.42 | 1991.04 → 2083.39 |
| open: longest pause | 127.73 → 141.62 | 133.74 → 143.03 |
| Enter paragraph | 13.43 → 8.69 | 15.89 → 15.98 |
| large paste + Unicode | 159.26 → 163.48 | 168.55 → 176.29 |
| redo large paste | 189.82 → 199.13 | 196.53 → 215.36 |
| move cursor 20 lines | 26.13 → 27.94 | 30.00 → 28.09 |

Type per character on long 5.74 → 4.90 ms, p95 16.18 → 7.99,
maximum 30.56 → 26.11. The total of opening long rose 5.5% and the pause rose 10.9%
(~14 ms). Limiting the tag priority can change the completion schedule, but
this measurement has not separated that cost from environment variation.
The mixed/book baselines were not replaced and there is no claim that all operations improved.

Validation: `npm test` **384 passed, 0 failed**. The whole log was read and is clean of
warnings, criticals, and runtime errors. The typecheck and the diff check passed.
The tests cover grids that have not been created off screen, the reservation height compared with
the GTK height, the stability of the document height after scrolling, Unicode contents, the theme, and
widget identity after the width changes. The mouse tests finish GC before
spinning the nested main loop so that the GJS destroy callbacks are not refused by GC.
Screenshots of the light/dark themes at the start and the end of the document were checked: the grid,
the paragraphs, and the sidebar appear without overlapping. The desktop `test:ui` was not
run because the displayed test mode was not requested, in line with the section
Test environment in AGENT.md; the GUI/mouse tests ran on Xvfb.

The last targeted check of mixed 25 used the final sources before/after,
10 repetitions each in separate processes, run in sequence:

| Operation | Median before → after | p95/maximum before → after |
| --- | ---: | ---: |
| setText + highlight + layout | 69.29 → 69.00 | 86.75 → 79.89 |
| open: longest pause | 20.82 → 19.92 | 34.18 → 23.67 |
| type via view | 2.23 → 2.10 | 11.79 → 10.73 |
| Enter paragraph | 3.67 → 3.73 | 14.16 → 14.75 |
| large paste + Unicode | 162.08 → 205.09 | 297.03 → 322.80 |
| redo large paste | 180.69 → 177.23 | 197.29 → 182.45 |

The maximum of type via view 14.22 → 14.81 ms. A redo regression against the historical
baseline did not appear in this comparison, but paste **rose 26.5%**.
The paste scenario inserts 100 Unicode lines and one line of 10,000 characters,
then waits for highlight/layout to finish; the runtime sources that changed are the table
layer and the choice of priority lines for the tag installments. Another run after the final
gave a paste of 158.80 ms, so the variation is large and the additional cost has not been
isolated to one of the paths. This rise of paste remains a limitation of the
change, and is not considered passed just because the total of the first open went down a lot.
All the final benchmark logs are complete and clean of runtime errors/warnings.


## Migration to GTK 4 (GTK 4.14.5, GtkSourceView 5, WebKitGTK 6.0)

The app moved from GTK 3.24.41 to GTK 4.14.5. The comparison was measured side by side on the
same machine (GJS 1.80.2, X11/Xvfb, host c640): the GTK 3 version was built from `main`
in a separate worktree, and then both versions were run in turn with the same fixture, size,
and 10 repetitions. The GTK 4 (cairo) column uses `GSK_RENDERER=cairo` to
separate the cost of the renderer from the cost of GTK 4 itself. All the median numbers are in ms.

| Operation (mixed 100 blocks, 30 KB) | GTK 3 | GTK 4 (GL) | GTK 4 (cairo) | p95/max GTK 3 → GTK 4 (GL) |
| --- | ---: | ---: | ---: | ---: |
| setText + highlight + layout | 216.24 | 283.81 | 244.91 | 228.05/228.05 → 308.27/308.27 |
| open: longest pause | 37.16 | 44.13 | 41.37 | 41.44/41.44 → 49.44/49.44 |
| type per character | 1.26 | 1.69 | 1.54 | 2.98/12.58 → 11.65/19.31 |
| type via view (paragraph) | 1.95 | 3.31 | 2.54 | 11.51/16.00 → 14.18/15.02 |
| Enter new paragraph | 2.30 | 3.22 | 2.23 | 10.42/10.42 → 14.12/14.12 |
| large paste + Unicode | 142.25 | 156.32 | 152.72 | 145.11/145.11 → 186.08/186.08 |
| redo large paste | 155.65 | 157.22 | 157.81 | 172.16/172.16 → 179.80/179.80 |
| move cursor 20 lines | 21.32 | 41.35 | 29.17 | 26.06/26.06 → 45.17/45.17 |

| Operation (book 400 blocks, 651 KB) | GTK 3 | GTK 4 (GL) | GTK 4 (cairo) | p95/max GTK 3 → GTK 4 (GL) |
| --- | ---: | ---: | ---: | ---: |
| setText + highlight + layout | 852.68 | 2394.35 | 1787.85 | 871.32/871.32 → 2716.54/2716.54 |
| open: longest pause | 64.51 | 97.44 | 92.18 | 81.16/81.16 → 116.75/116.75 |
| type per character | 1.95 | 2.87 | 2.29 | 4.39/14.38 → 15.06/36.74 |
| type via view (paragraph) | 2.72 | 6.24 | 4.20 | 12.93/14.73 → 17.60/18.94 |
| Enter new paragraph | 3.37 | 18.02 | 4.17 | 12.30/12.30 → 31.26/31.26 |
| large paste + Unicode | 140.34 | 191.69 | 151.21 | 155.24/155.24 → 205.06/205.06 |
| redo large paste | 168.62 | 197.66 | 230.56 | 178.64/178.64 → 216.48/216.48 |
| move cursor 20 lines | 14.69 | 43.89 | 47.53 | 21.96/21.96 → 59.41/59.41 |

Findings and their causes:

- **Drawing dominates the difference on Xvfb.** Xvfb has no GPU, so the default
  OpenGL renderer of GTK 4 runs on llvmpipe (Mesa, software), while GTK 3
  draws with cairo. With `GSK_RENDERER=cairo` most of the difference disappears
  (e.g. Enter on the book 18.02 → 4.17, type via view on the book 6.24 → 4.20). The development
  machine has an Intel UHD GPU; on a real desktop GTK 4 uses hardware
  OpenGL, so these Xvfb numbers are the worst case (equivalent to a machine without a GPU).
- **The longest pause of opening the 651 KB book rose 64.51 → 97.44 ms** (p95 81.16 → 116.75).
  That pause is entirely the synchronous `setText()`. Measured separately: the equivalent `highlight()`
  (about 40–45 ms in both versions), but `GtkTextBuffer.set_text()` that replaces the old
  contents rose from about 27 ms (GTK 3) to about 45–58 ms (GTK 4). Turning off undo or using
  a non-undoable action does not change it; detaching the buffer from the view during `set_text()`
  gave unstable results and added a pause of about 25–46 ms afterwards, so it is not used.
  This is the cost of GTK 4.14 itself, not Markwork code.
- **The total of opening (until all the layout finishes) rose 2–2.8×** on the book. The background layout
  and the drawing run in idle; the window still responds (see the longest pause).
- **Moving the cursor 20 lines rose about 3×** on the book with both renderers. Measured in a separate
  editor, `updateCursor()` (hidden markers, focus mode) stays about 0.25 ms per
  move; the rest is the GTK 4 frame cycle that is also waited for by `idle(PRIORITY_LOW)` in the
  measurement. Per move it stays about 2 ms, far below one 16 ms frame.
- The Markdown model (without GTK) did not change: markdownToHtml 7.75 → 7.80 ms,
  parseInline 2.59 → 2.75 ms.

The child process of the 400-block book on GTK 4 (GL) needs about 230 seconds on Xvfb, exceeding the default limit of
120 seconds; measure the book with `--timeout=600`.

**The baseline was replaced** with these complete and valid GTK 4 (GL) results:
`bench/baseline.json` (mixed) and `bench/baseline-book.json` (book, `--timeout=600`).
The old baseline used GTK 3.24.41, so `bench:compare` already considers it not
equivalent and skips its difference; the new baseline guards the next regressions on GTK 4.
The regressions above are still recorded as a limitation of the migration, not hidden.

Limitations: not measured on Wayland (a desktop with a GPU: see the next subsection). Functional validation: `npm test` **391 passed, 0 failed**, twice
in a row, the whole log clean of warnings, criticals, and errors.

### A desktop with a GPU (X11, Intel UHD, hardware OpenGL)

Measured side by side on an XFCE/X11 desktop (not Xvfb); the default renderer of GTK 4 uses
hardware OpenGL (Mesa Intel UHD CML GT2). 10 repetitions, `--timeout=600`:

| Operation (mixed 100 blocks, 30 KB) | GTK 3 | GTK 4 | p95/max GTK 3 → GTK 4 |
| --- | ---: | ---: | ---: |
| setText + highlight + layout | 202.22 | 207.55 | 223.16/223.16 → 220.06/220.06 |
| open: longest pause | 36.84 | 42.03 | 50.57/50.57 → 48.24/48.24 |
| type per character | 1.22 | 1.51 | 3.66/10.41 → 3.70/6.50 |
| type via view (paragraph) | 2.13 | 2.52 | 10.51/15.12 → 6.96/13.79 |
| Enter new paragraph | 2.62 | 2.90 | 10.92/10.92 → 5.70/5.70 |
| large paste + Unicode | 137.82 | 134.04 | 139.49/139.49 → 143.97/143.97 |
| redo large paste | 154.06 | 165.13 | 167.35/167.35 → 178.09/178.09 |
| move cursor 20 lines | 18.97 | 19.94 | 24.48/24.48 → 23.22/23.22 |

| Operation (book 400 blocks, 651 KB) | GTK 3 | GTK 4 | p95/max GTK 3 → GTK 4 |
| --- | ---: | ---: | ---: |
| setText + highlight + layout | 799.29 | 920.37 | 834.25/834.25 → 972.52/972.52 |
| open: longest pause | 71.03 | 85.09 | 80.98/80.98 → 95.93/95.93 |
| type per character | 1.92 | 2.23 | 5.07/13.28 → 5.66/9.76 |
| type via view (paragraph) | 2.69 | 3.63 | 7.26/11.67 → 8.03/9.18 |
| Enter new paragraph | 3.70 | 3.83 | 9.80/9.80 → 6.06/6.06 |
| large paste + Unicode | 148.61 | 137.94 | 151.61/151.61 → 151.00/151.00 |
| redo large paste | 166.45 | 164.58 | 180.00/180.00 → 177.19/177.19 |
| move cursor 20 lines | 14.13 | 22.34 | 15.01/15.01 → 24.31/24.31 |

With a GPU, most of the Xvfb regression disappears: the mixed document is on par with GTK 3 (the p95
of typing and Enter are even lower), and the 651 KB book is left with only a **pause of opening
71.03 → 85.09 ms** (its source is GTK 4 `set_text()`, see above), a total of opening +15%,
and moving the cursor 20 lines 14.13 → 22.34 ms (about 1.1 ms per move). The baseline stays
from Xvfb (the environment of `npm run bench:compare`); these desktop numbers are only a comparison.
Validation: `npm run test:ui` on the desktop **391 passed, 0 failed**, a clean log.

## Regression check after the new features (2026-10-07)

61 commits since the GTK 4 baseline (the inbox, Home, wikilinks, list indentation, code blocks as a
scrollable box, GNOME adjustments, etc.). `bench:compare` and the book fixture were run against
`baseline.json`/`baseline-book.json` (X11/Xvfb, GTK 4.14.5, 10 repetitions). The big regressions:

| Operation | Baseline | Before the fix | After the fix |
| --- | ---: | ---: | ---: |
| mixed 30 KB, open: longest pause | 44.13 | 67.65 | 53.42–54.34 |
| mixed 30 KB, move cursor 20 lines | 41.35 | 80.32 | 45.40–52.69 |
| mixed 30 KB, delete large text | 3.05 | 8.07 | 3.49–3.79 |
| mixed 30 KB, undo large paste | 3.64 | 8.05 | 3.79–4.19 |
| book 325 KB, open: longest pause | 46.66 | 90.02 | 49.13–51.10 |
| book 651 KB, open: longest pause | 97.44 | 139.75 | 95.10–107.42 |

The "after" column is two separate full runs. A bisect in a worktree (mixed 100 blocks, 5 repetitions)
and a per-method profile showed two sources:

- **The code block layer (`codelayer.ts`, d21cfb0)** ran a full `sync()` (an iter per block,
  a tag diff of the whole buffer) every time the cursor entered/left a block and every edit that only
  shifted lines: about 4 ms per call at 100 blocks, plus GTK laying out again. Now it is the same as
  `TableLayer`: `setCursor()` only applies/removes the tags of the block that switched, and a line shift
  without a content change only moves the widget (the GTK tags shift along). A profile of 80 cursor
  moves: `CodeLayer.sync` 73.9 ms → 0.
- **The outline (`Gio.ListStore`, b51c43b)** made all the items at once when opening another document
  (about 0.1 ms per item, about 20 ms for 440 headings in a 651 KB manuscript), inside the opening pause. Small
  changes (≤ 8 items, e.g. editing one heading) are still immediate; large changes are done in installments of 25 items
  per turn in the idle `HIGH_IDLE + 21`, after the frame is drawn and before the editor tag installments.

The remaining differences that are not considered a code regression:

- **Enter new paragraph** about 14–16 ms (baseline 2.5–3.2) also on the book without code/table blocks.
  The JS profile is about 2.6 ms per Enter. With `GSK_RENDERER=cairo` (book 50 blocks) Enter is 2.72 ms
  (p95 7.30) vs GL 10.31 ms (p95 29.38): that is a frame drawn by llvmpipe in the middle of the measurement,
  as recorded in the GTK 4 migration section. The Enter numbers on Xvfb-GL are bimodal between runs.
- **setText + highlight + layout** (the total until idle) +15–24% on mixed: the initial cost of the new code
  layer (`CodeLayer.sync` and `CodeHighlighter.apply` about 4 ms per open at 100 blocks) and
  laying out the boxes; the longest pause stays close to the baseline.

Validation: `npm test` **574 passed, 0 failed**, a clean log; a new test checks the `codehide` tags
exactly on the lines of each block after the cursor goes in and out and a line is inserted above a block.
The baseline was not replaced.

### The second round: reused iters and the word counter (2026-10-07)

A per-method profile (the cairo renderer so the drawing time does not mix in) with timing wrappers
on the `GtkTextBuffer` calls. When opening mixed 30 KB there are about 3,100 `get_iter_at_offset`
and 400 `get_iter_at_line` per open. A GJS microbench (20,000 calls): `get_iter_at_offset`
36.7 ms vs `set_offset()` on an existing iter 11.9 ms; `get_iter_at_line` 49.5 vs `set_line()`
11.3 ms; `apply_tag` with two new iters 65.6 vs two reused iters 37.3 ms. Making a new
boxed `TextIter` in GJS is far more expensive than looking up its position.

- `tagsync.ts`: `setTagRanges()` and `LineTagger` use `IterPair` (two iters, `set_offset`).
  Applying/removing a tag does not invalidate the iters, only a text change does.
- The code, table, and mermaid layers compute the block offsets with one iter (`lineSpanOffsets()`).
- `LineTagger`: a small number of unknown lines (≤ 8, e.g. a line that was just edited) are only
  removed from the syntax tags that are really applied (a toggle walk), not about 31 `remove_tag` per
  keystroke.
- The word count per line (`countWords()`, also the status bar) is computed with a character code loop,
  not `match(/…/g)` which makes one string per word (about 100,000 strings per open of a 651 KB manuscript).
  A microbench of 322,586 words: 35–44 → 12.8 ms. A unit test compares it with the old regex on
  500 random strings (Unicode spaces, emoji, Markdown symbols).

A per-open profile (median of 6): mixed 30 KB synchronous pause max 69.5 → 51.7 ms; book 651 KB
111.3 → 87.2 ms, the parser (`HighlightCache.update`) 26.5 → 16.7 ms. Typing: `LineTagger`
0.37 → 0.18 ms per keystroke. The biggest remainder of opening is `GtkTextBuffer.set_text()` itself
(about 23 ms mixed, about 44 ms book).

The full bench (Xvfb GL, 10 repetitions) against the baseline:

| open: longest pause | Baseline | First round | After the second round |
| --- | ---: | ---: | ---: |
| mixed 7 KB | 20.48 | 21.04–22.07 | 15.91 |
| mixed 15 KB | 26.44 | 29.44–29.68 | 22.16 |
| mixed 30 KB | 44.13 | 53.42–54.34 | 41.38 |
| book 81 KB | 16.18 | 16.44–17.73 | 14.49 |
| book 325 KB | 46.66 | 49.13–51.10 | 39.86 |
| book 651 KB | 97.44 | 95.10–107.42 | 79.79 |

Type per character mixed 30 KB 1.52 ms (baseline 1.69), book 651 KB 2.97 (2.87). Moving the
cursor and Enter still fluctuate between runs on Xvfb GL (e.g. the cursor on book 651 KB 32–59 ms
in three runs without a change to the cursor path in between); see the note about llvmpipe frames above.
Validation: `npm test` **575 passed, 0 failed**, a clean log. The baseline was not replaced.

## Home reads boards past the first 300 files (2026-10-08)

A fix, not an optimization. `homeData()` called `readProject()`, which stops after 300 Markdown files
before checking whether a file is a board or an inbox. Boards and inboxes later in the alphabetical walk
never reached the due dates or the inbox counts on Home. `readProject()` now takes a `keep` filter
that is applied before the limit, and it drops cache entries of files under the root that were deleted.

Micro-benchmark of the Home data path (walk + `dueTasks` + `openInboxes`, warm cache, 10 repetitions,
a synthetic folder where every tenth file is a board with 40 cards; not in the repo):

| Workspace | Before (median) | After (median) | Boards found before → after |
| --- | ---: | ---: | ---: |
| 300 files | 14.65 ms | 14.64 ms | 30 → 30 |
| 1,000 files | 18.20 ms | 49.47 ms (max 80.14) | 30 → 100 |

At 1,000 files the cost rises because all files are now walked and all 100 boards are parsed; the old
number was cheaper only because it ignored 70% of them. This runs synchronously each time the window
becomes active while Home is shown. Caching the parsed boards by file stamp would remove most of the
`dueTasks` part; that has not been done yet. The editor benchmark is not affected (no editor code changed).
