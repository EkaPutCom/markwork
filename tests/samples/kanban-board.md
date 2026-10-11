---
layout: table
fields:
  priority: select(high:red, medium:amber, low:gray)
  progress: progress
  owner: person
  estimate: number
  spec: link
  created: date = today
---

## Plan

- [ ] User research #research [priority:: high] [owner:: Eka] [estimate:: 5] [due:: 2026-10-10]
  Interview five active users.
  - note the main needs
- [ ] Redesign the home page #design [priority:: medium] [spec:: [[Home design]]]
- [ ] Write the **API** documentation #docs [priority:: low] [estimate:: 3] [due:: 2026-10-25]

## In Progress

- [ ] Implement the kanban board #feature #important [priority:: high] [progress:: 3/5] [owner:: Eka]
- [ ] Fix the `HTML export` bug #bug [priority:: high] [progress:: 60%] [due:: 2026-10-03] [agent:: pi]

## Review

- [ ] Trial on Ubuntu 24.04 #qa [priority:: medium] [owner:: Rina]

## Done

- [x] Choose the project name: Nyerat [priority:: low]
- [x] Set up the GitHub repository #infra [progress:: 100%]
