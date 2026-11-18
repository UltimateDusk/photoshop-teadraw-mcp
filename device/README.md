# TeaDraw MCP Windows bridge

This directory connects an owner-private TeaDraw relay to the local `@alisaitteke/photoshop-mcp` STDIO server.

## Files

- `bridge.cjs` — private relay polling, bounded brush/erase engine, and curated tool dispatch.
- `collab-runtime.cjs` — monotonic revisions, long polling, region previews, safe save/export, text, groups, canvas operations, and collaboration sessions.
- `setup-device-credential.ps1` — interactively creates a DPAPI-encrypted device credential.
- `start.cmd` / `stop.cmd` — start and stop the bridge.
- `collab-runtime.test.cjs` — deterministic revision tests.
- `integration-smoke.cjs` — real Photoshop temporary-document smoke test.

## Credential setup

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-device-credential.ps1 `
  -ServiceUrl "https://your-private-service.example"
```

The token is requested with `Read-Host -AsSecureString` and the resulting JSON is encrypted with Windows DPAPI for the current user. The encrypted file cannot normally be moved to another Windows account or computer.

Never commit `device-credential.dpapi`, `bridge.log`, `bridge.pid`, `revision-state.json`, or `stop.request`.
