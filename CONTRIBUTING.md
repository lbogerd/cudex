# Cudex pilot contributor checklist

Before each implementation commit:

- inspect `git status` and preserve unrelated changes;
- update `README.md` when workflow, limitations, output, setup, or recovery changes;
- update `TODO.md` when work or a pilot shortcut is added, completed, split, or deferred;
- update `ARCHIVE.md` for stable decisions, resolved TODOs, provenance, and new test evidence;
- place a specific `TODO(internal-release, PILOT-nnn)` comment beside every pilot-only branch;
- run the shortcut registry test and focused tests;
- inspect the complete staged diff and stage intended paths explicitly;
- verify no credential, `.env`, auth file, artifact, state, log, report, or generated output is staged.

After the focused checks, run:

```bash
npm run build --prefix e2b
npm test --prefix e2b
```

Commit reviewable chunks on `cudex/coworker-pilot`. Push the first commit with
`git push -u origin cudex/coworker-pilot` and later commits with
`git push origin HEAD`. Never force-push, push directly to `main`, or amend a
shared chunk unless explicitly requested.
