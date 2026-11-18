# Contributing

Before proposing a change:

1. Keep existing tool names and argument semantics compatible.
2. Require an exact positive `document_id` for every document edit.
3. Add `expected_revision` support to new mutating tools.
4. Do not expose arbitrary scripts or local-file opening.
5. Require explicit paths and overwrite intent for every file write.
6. Verify actual pixels, bounds, hierarchy, dimensions, or output files after writes.
7. Keep edits reversible with Photoshop history where possible.
8. Add schema tests and a temporary-document integration check.

Run before submitting:

```powershell
node --test .\device\collab-runtime.test.cjs
Set-Location .\cloud
node --test worker.test.mjs
npm.cmd run build
npm.cmd run validate
```
