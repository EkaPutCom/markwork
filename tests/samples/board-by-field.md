---
layout: board
group: status
add: top
fields:
  status: select(planned:gray, doing:blue, review:purple, done:green)
  priority: select(high:red, medium:amber, low:gray)
---

# Product backlog

The columns are the values of the status field, not headings. Dragging a card to another column changes its status. Cards without a status wait in the first column. Remove group: status and the same file is an ordinary board.

- [ ] Research PDF export #idea
- [ ] Release notes [status:: planned] [priority:: medium] [due:: 2026-10-21]
- [ ] Write the changelog [status:: planned] [priority:: low]
- [ ] Fix the sync bug #bug [status:: doing] [priority:: high] [due:: 2026-10-19]
- [ ] Review the parser [status:: review] [priority:: high]
- [x] Design the home page [status:: done] [priority:: medium]
- [x] Migration to GTK 4 [status:: done] [priority:: high]
