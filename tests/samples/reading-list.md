---
layout: list
add: bottom
fields:
  status: select(queued:gray, reading:blue, done:green) = queued
  progress: progress
  rating: number
  added: date = today
---

# Reading list

New items go to the bottom and start as queued. The headings are sections in this list. Open the text view (Ctrl+Shift+B), change layout: list to layout: board, and go back: the same file is now a board, with one column per heading.

- [ ] Designing Data-Intensive Applications [status:: reading] [progress:: 260/616] [added:: 2026-09-20]
- [ ] The Pragmatic Programmer [status:: reading] [progress:: 35%] [added:: 2026-10-02]

## Up next

- [ ] A Philosophy of Software Design [status:: queued] [added:: 2026-10-05]
- [ ] Refactoring [status:: queued] [added:: 2026-10-08]

## Finished

- [x] Clean Code [status:: done] [rating:: 4] [added:: 2026-08-14]
- [x] The Mythical Man-Month [status:: done] [rating:: 5] [added:: 2026-07-30]
