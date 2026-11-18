# TeaDraw MCP cloud relay

Owner-private MCP relay for the Windows TeaDraw Photoshop bridge.

The server exposes 49 curated tools and stores short-lived jobs, results, and device heartbeats in an R2 binding named `BUCKET`. Arbitrary script execution and remote local-file opening are intentionally absent.

## Local checks

```powershell
node --test worker.test.mjs
npm.cmd run build
npm.cmd run validate
```

`scripts/build.mjs` copies `.openai/hosting.json` when present. For source-only validation it falls back to `.openai/hosting.example.json`; a placeholder archive must never be deployed.

Before deployment, copy the example file to `.openai/hosting.json`, insert the exact owner-private Site project ID, and preserve that Site's existing access policy. The real file is ignored by Git.
