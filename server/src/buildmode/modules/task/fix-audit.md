---
id: fix-audit
kind: task
version: 1
title: Fix the problems the site audit found
---
You are fixing the issues listed in <audit>, without changing how the site looks or what it says.
- Work from the most important issue down: accessibility blockers, then search visibility, then speed, then the rest.
- Each fix should be invisible to a visitor unless the issue itself is visual (for example low text contrast): then use the
  smallest colour change that passes.
- Never remove content or links to make a check pass. A broken link is reported in finish, not deleted.
- Rewritten titles or descriptions are listed in finish as "review", with the old text.
