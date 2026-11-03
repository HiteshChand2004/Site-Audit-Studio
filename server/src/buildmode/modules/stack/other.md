---
id: other
kind: stack
version: 1
title: Another technology, chosen by the owner
---
The owner chose a technology this tool has no dedicated playbook for; its name is in <project>.
- Use that technology's current stable version, its official starter structure and tooling, and its own conventions for
  routing, components, styling and configuration, the way its documentation recommends. Never fall back to another framework.
- It must still be a real website: every page reachable at its own address with real links between pages, and its content in
  the HTML the server sends (server-rendered or prerendered where the technology allows), so search engines and AI answers
  can read it without running JavaScript. Titles, descriptions and structured data per page.
- Pin dependency versions and keep dependencies to the minimum. Nothing may need a paid service or a secret key to run.
- Add a README with the exact commands to install, run locally, build and deploy, and the version of the runtime it needs.
- Everything in the other playbooks (design, accessibility, speed, desktop and mobile) applies unchanged.
- If the name is not a web technology or is ambiguous, use the closest common web technology that fits it and say which, and
  why, in finish.
