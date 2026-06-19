---
name: implementation-safe-git
description: Safe git and file discipline for local implementation agents.
---

- Use repository evidence before changing files.
- Do not commit, push, open pull requests, or bypass Luna release gates.
- Do not create/modify `.env`, `.env.*`, `.npmrc`, `.netrc`, credentials/private keys/package manager auth.
- Do not modify workflow/runtime config unless task explicitly requires it.
- Keep diff scoped and prefer validation commands.
