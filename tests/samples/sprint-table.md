---
layout: table
add: top
columns: [title, status, priority, owner, due, progress]
sort: due
fields:
  status: select(todo:gray, doing:blue, review:purple, done:green) = todo
  priority: select(high:red, medium:amber, low:gray)
  owner: person
  due: date
  progress: progress
---

# Sprint

One row per note, one column per field. Click a header to sort, a cell to change it, a title to edit the note. Change layout: table to layout: board and the same file is a board.

- [x] Inventory of the widgets [status:: done] [priority:: low] [owner:: Eka] [due:: 2026-10-08] [progress:: 100%]
- [x] Tidy up the tag chips [status:: done] [priority:: low] [owner:: Rina] [due:: 2026-10-09] [progress:: 100%]
- [ ] Parser for key:: value [status:: review] [priority:: high] [owner:: Eka] [due:: 2026-10-13] [progress:: 5/5]
- [ ] Fix the checkout [status:: doing] [priority:: high] [owner:: Eka] [due:: 2026-10-14] [progress:: 3/5]
- [ ] GUI tests for the popover [status:: doing] [priority:: medium] [owner:: Eka] [due:: 2026-10-15] [progress:: 40%]
- [ ] Design the field schema [status:: todo] [priority:: medium] [owner:: Rina] [due:: 2026-10-16]

## Backlog

- [ ] Write the API documentation [priority:: low] [owner:: Rina] [due:: 2026-10-24]
- [ ] Release 1.0 [priority:: high] [owner:: Eka] [due:: 2026-10-30]
