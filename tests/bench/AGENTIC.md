# Performance check of the agentic features — 5 October 2026

The new features include the work plan, change batches, verification, the journal, checkpoints,
retry, and history excerpts. The local measurements do not call a model provider.

These numbers were measured on the GTK build (GJS), before it was removed. `npm run bench:agentic` now runs the
same measurements on Node; their numbers are not comparable with the ones below.

## The cost of batches and checkpoints

Command: `npm run bench:agentic`. Ten repetitions after three warm-ups,
20 files per batch, sizes of 30,000 and 480,000 characters per file. The fixture replaces
the whole contents of a file; this is deliberately heavier than replacing a single date.
A checkpoint covers serialization, a synchronous write, a read, and parsing again to make sure the
snapshot is complete. The control uses the same question/answer without a journal;
this control measures the additional cost of the metadata, not a comparison with the whole old app.

| Operation | Size per file | Median (ms) | p95 (ms) | Maximum (ms) |
| --- | ---: | ---: | ---: | ---: |
| Plan batch | 30,000 characters | 8.984 | 12.003 | 12.003 |
| Verify the result | 30,000 characters | 0.246 | 0.329 | 0.329 |
| Text checkpoint without a journal (control) | 30,000 characters | 3.524 | 4.506 | 4.506 |
| Checkpoint with a journal | 30,000 characters | 19.460 | 31.577 | 31.577 |
| Plan batch | 480,000 characters | 113.940 | 122.101 | 122.101 |
| Verify the result | 480,000 characters | 3.428 | 4.734 | 4.734 |
| Text checkpoint without a journal (control) | 480,000 characters | 3.455 | 4.611 | 4.611 |
| Checkpoint with a journal | 480,000 characters | 188.555 | 212.635 | 212.635 |
| Summarize 200 turns (24,000 characters/turn) | — | 2.928 | 5.321 | 5.321 |

The journal stores before/after snapshots so that a diff can be opened again and an interruption
can be reconciled. The cost is real: a batch of 20 large documents can hold up the main thread.
The checkpoint numbers above also include a reread that the app does not do
on every save, so they are not a direct measurement of a UI pause.
Writing a checkpoint is still synchronous; this result does not prove comfort for
a conversation with hundreds of large snapshots. There is no claim of a performance improvement.

## The editor benchmark

`npm run bench:compare` finished on the mixed fixture, 100 blocks for the module and 25/50/100
GUI blocks, 10 repetitions, with the project baseline kept unchanged.
In the first measurement, Enter at 50 blocks rose from a median of 2.67 to 6.93 ms
(p95/maximum 13.77 ms), while 25 and 100 blocks were 2.44 and 2.40 ms.
This number was checked again with a snapshot of the code before the change in the same
environment; the direct comparison that follows shows that the rise of Enter did not repeat.

| Operation (50 blocks) | Median before → after (ms) | p95 before → after (ms) | Maximum before → after (ms) |
| --- | ---: | ---: | ---: |
| setText + highlight + layout | 140.054 → 131.954 | 165.093 → 144.422 | 165.093 → 144.422 |
| open: longest pause | 24.382 → 24.142 | 33.760 → 28.203 | 33.760 → 28.203 |
| type per character | 1.088 → 1.114 | 12.177 → 9.052 | 16.455 → 16.218 |
| Enter new paragraph | 2.328 → 1.885 | 13.008 → 12.342 | 13.008 → 12.342 |
| large paste + Unicode | 131.704 → 142.518 | 160.982 → 149.871 | 160.982 → 149.871 |
| undo large paste | 2.415 → 2.477 | 3.758 → 3.702 | 3.758 → 3.702 |
| redo large paste | 145.763 → 153.611 | 157.563 → 166.101 | 157.563 → 166.101 |

Both measurements use the mixed fixture, 100 module blocks, 50 GUI blocks, 10 repetitions, and the same GJS/GTK and Xvfb configuration. The snapshot before comes from the HEAD when the work started, built in a temporary folder with the same dependencies. Enter went down from 2.328 to 1.885 ms in the direct measurement; this is not counted as an optimization because the Enter implementation did not change. findTables rose by about 32% but only 0.25 → 0.33 ms (p95 0.31 → 0.49 ms); the parser code did not change and a number this small is sensitive to noise. There was no editor median regression of more than 25% in the direct comparison. The result was not used to replace the project baseline.

This measurement does not assess the API latency, the accuracy of the model's choice of criteria,
the ability of the model to write a plan, or how long the user takes to review a diff. A model evaluation
is available through `npm run test:live -- --agentic`; it was not run in this session because it
uses API quota.

## Additional actions and verification — 5 October 2026

The changes: the tools `insert_text`, `delete_file`, `move_file`, `edit_file` with `all`,
additional kanban actions, partial batch approval, Undo, the Git history tools, and the verification of
structure (`markdown/lint.ts`) and the search for leftover text across the whole folder (the file `"*"`).

`npm run bench:agentic`, 10 repetitions after 3 warm-ups, 20 files per batch; the shape of the fixture
is the same as in the section above (files without tables or links, so the whole cost is walking the lines).
The structure verification parses every file twice (the current contents and the contents from before the work).

| Operation | Size per file | Median (ms) | p95 (ms) | Maximum (ms) |
| --- | ---: | ---: | ---: | ---: |
| Verify structure (with baseline) | 30,000 characters | 10.113 | 10.808 | 10.808 |
| Find leftover text across the folder (`*`) | 30,000 characters | 0.279 | 0.621 | 0.621 |
| Verify structure (with baseline) | 480,000 characters | 157.345 | 160.572 | 160.572 |
| Find leftover text across the folder (`*`) | 480,000 characters | 3.394 | 4.627 | 4.627 |

The first version of the structure check ran three walks per document (frontmatter/code,
tables, links) and trimmed every line: 396.9 ms (p95 404.6) for 20 × 480,000 characters,
and `"*"` split all the files into lines even when the text was not there (66.6 ms). After merging them
into one walk with a character filter before the regex, and `"*"` only splitting the files that
contain the text, the numbers became as in the table above. This is an optimization of new code within the same
work, not an improvement of an old feature. The check runs on the main thread once per call of
`verify_work`, not while typing; 157 ms for about 19 million characters (twice 20 × 480,000) is still felt as a pause.

The old operations in the same measurement were compared with a snapshot of the HEAD before the change
(built in a temporary worktree, the same dependencies and environment): plan batch 480,000 characters
115.9 → 110.4 ms, verify the result 3.48 → 3.49 ms, checkpoint with a journal 198.4 → 215.6 ms
(p95 215.4 → 244.8). The checkpoint code did not change; the journal can now hold `to` for a move,
which this fixture does not use, so the difference is counted as noise in the disk write measurement.

The editor benchmark (`bench:compare`, the mixed fixture, 25/50/100 blocks, 10 repetitions) was run for
the snapshots before and after. The editor code did not change. One first reading of "delete large text"
at 25 blocks, 6.28 → 19.58 ms, did not repeat: the next two repetitions were 7.73/8.84 ms (before) and
7.06/8.05 ms (after). Enter new paragraph fluctuated in both directions on both snapshots
(the snapshot before itself recorded +119% at 100 blocks). No editor regression repeated;
the baseline was not replaced.

## Agent folders — Node checkpoint, 31 October 2026

`npm run bench:agentic`, 10 repetitions after 3 warm-ups, no model requests.

| Operation | Size per file | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Plan batch | 30,000 | 3.268 | 3.884 | 3.884 |
| Verify result | 30,000 | 0.033 | 0.071 | 0.071 |
| Checkpoint with journal | 30,000 | 11.372 | 16.269 | 16.269 |
| Plan batch | 480,000 | 60.859 | 69.057 | 69.057 |
| Verify result | 480,000 | 0.384 | 0.529 | 0.529 |
| Checkpoint with journal | 480,000 | 170.804 | 187.414 | 187.414 |
| Summarize 200 turns | — | 1.664 | 1.742 | 1.742 |

The earlier eager implementation's cold start to an agent page and 200-session
list (100 reference phrases per stored answer, 7 fresh Electron launches) measured
median 1198.468 ms, p95/maximum 1224.283 ms. Controllers are now loaded lazily, but
the equivalent rerun was blocked when escalation review hit its usage limit.
No speedup or regression claim is made from unmatched fixtures. Switching, 1,000
records, replay, ownership contention, and memory measurements remain pending.
The GTK numbers above are historical and are not a Node comparison baseline.

## Chat layout marker — 31 October 2026

After replacing agent-folder transcript flags with `layout: chat`,
`npm run bench:agentic` (10 repetitions, 3 warm-ups, same 20-file fixtures) reports:

| Operation | Characters per file | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Plain checkpoint | 30,000 | 1.849 | 2.042 | 2.042 |
| Journal checkpoint | 30,000 | 12.091 | 15.838 | 15.838 |
| Plain checkpoint | 480,000 | 1.795 | 1.929 | 1.929 |
| Journal checkpoint | 480,000 | 181.511 | 204.055 | 204.055 |

The benchmark's ordinary history fixtures retain their unmarked format; it checks
the shared parser/serializer pipeline, not a workload consisting only of agent
folders. Compared with the prior checkpoint samples above, journal medians rose
6.3% and 6.3%, while plain checkpoint medians fell 2.2% and 10.8%. A single run
does not attribute this variation to the constant-size marker check. No
performance improvement is claimed. The chat marker is covered separately by transcript round-trip tests.

## Canonical chat marker only — 31 October 2026

After removing the Boolean marker fallback, `npm run bench:agentic` ran after
the full test suite (10 repetitions, 3 warm-ups; unchanged 20-file fixtures):

| Operation | Characters per file | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Plain checkpoint | 30,000 | 1.837 | 2.006 | 2.006 |
| Journal checkpoint | 30,000 | 11.445 | 14.170 | 14.170 |
| Plain checkpoint | 480,000 | 1.604 | 1.814 | 1.814 |
| Journal checkpoint | 480,000 | 182.501 | 205.072 | 205.072 |

Against the preceding samples, journal medians vary by -5.3% and +0.5%.
These pipeline samples do not isolate the marker condition and do not establish
an attributable speedup or regression. Canonical and unrelated marker behavior
is checked in the transcript tests. Full `npm test` passes with 894 core tests.

## Explorer transcript navigation — 31 October 2026

Real Electron, a parent workspace with an ordinary notes folder and a configured
child agent; one saved conversation and an ordinary plan document. Twenty
activations from the plan tab through the transcript's Explorer row measured
median 129.756 ms, p95 172.168 ms, maximum 537.954 ms. Timing includes Playwright
click overhead and initial activation; no provider call is made. Light, dark,
and 560-pixel screenshots have no overflow or renderer errors.

This is an opening-latency check, not an isolated speedup claim. The file-routing
hook checks bounded frontmatter before parsing a conversation, so ordinary files
do not acquire a full transcript parse. Large-history and memory comparisons
remain outside this measurement.

Agentic pipeline recheck for this change: 10 repetitions after 3 warm-ups, 20
files per batch. Journal checkpoints: 30,000 characters per file median 11.084
ms, p95/maximum 11.723 ms; 480,000 characters per file median 185.645 ms,
p95/maximum 208.274 ms. Plain checkpoints: 1.690/1.830/1.830 ms and
1.824/1.930/1.930 ms (median/p95/maximum). Relative to the preceding journal
samples, medians vary by -3.2% and +1.7%; this does not isolate a navigation
regression or improvement. Full npm test passes with 897 core tests, the new
protocol route scenario, and eight Electron agent-folder steps.

## Active-tab panels and session rows — 31 October 2026

Real Electron, a configured child agent and two saved chat sessions, with an
ordinary Markdown plan beside them. Twenty alternating clicks on session rows
measured median 111.259 ms, p95 136.275 ms, maximum 139.833 ms, including
Playwright overhead. Both sessions retain their history and one tab each. The
same fixture verifies ordinary Assistant for the document and Sessions for chat,
with screenshots in light/dark and a 560-pixel floating Assistant. No renderer
errors or horizontal overflow occurred. This is a navigation latency check, not
an isolated speedup or regression comparison.

## Long chat containment — 31 October 2026

A real Electron fixture contains 25 saved turns, repeated research paragraphs,
lists, and long fenced code lines. Same 1400 × 900 viewport before and after:

| Geometry | Before | After |
| --- | ---: | ---: |
| Pane height px | 754 | 754 |
| Embedded chat height px | 13,693 | 754 |
| Body scroll height px | 13,807 | 900 |
| Message viewport height px | 13,551 | 612 |
| Message scroll height px | 13,551 | 13,551 |
| Composer top px | 13,745 | 806 |

Thirty alternating 100% / (100% - 4px) chat-width updates with a forced composer
layout read measured median 1.800 ms, p95 2.700 ms, maximum 2.700 ms after the fix.
No before/after speedup is claimed; the paired measurement demonstrates corrected
scroll ownership. Provider/network latency, memory, and very large history
virtualization are outside this check.

The Electron regression also gates a fake provider mid-stream, verifies automatic
follow after Send and preserved position when reading older messages, then checks
both themes, a 560-pixel viewport, and vertically split chats. No live API is used.

Validation: typecheck and full npm test pass (897 core tests and all Electron suites, including four long-chat layout steps). Logs have no app errors or stack traces.
