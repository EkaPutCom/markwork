---
layout: chart
by: created
group: status
period: week
fields:
  created: date
  due: date
  status: select(todo:gray, doing:blue, done:green) = todo
---

# October summary

Counts and charts over the notes below; nothing here changes them. Change layout: chart to layout: table and the same file is a table.

- [x] Design the home page #design [created:: 2026-10-01] [due:: 2026-10-08] [status:: done]
- [x] Migration to GTK 4 #docs [created:: 2026-10-02] [due:: 2026-10-09] [status:: done]
- [x] Release 0.8 #release [created:: 2026-10-06] [due:: 2026-10-10] [status:: done]
- [x] Update the screenshots #docs [created:: 2026-10-07] [status:: done]
- [ ] Fix the sync bug #bug [created:: 2026-10-08] [due:: 2026-10-09] [status:: doing]
- [ ] Fix the checkout #bug [created:: 2026-10-13] [due:: 2026-10-14] [status:: doing]
- [ ] Write the API documentation #docs [created:: 2026-10-13] [due:: 2026-10-24] [status:: todo]
- [ ] Tidy up the icons #design [created:: 2026-10-14] [status:: todo]
- [ ] Research PDF export #idea [created:: 2026-10-20] [status:: todo]
- [ ] Release 0.9 #release [created:: 2026-10-21] [due:: 2026-10-31] [status:: todo]
- [ ] Write the changelog #docs [created:: 2026-10-21]
