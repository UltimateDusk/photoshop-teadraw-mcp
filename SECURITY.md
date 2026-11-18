# Security policy

## Do not commit secrets

Never commit any of the following:

- `device/device-credential.dpapi`
- bearer tokens or OAuth credentials
- a real owner-private `.openai/hosting.json`
- bridge logs, PID files, revision state, previews, PSD files, or exported artwork

The repository `.gitignore` blocks the expected runtime files, but contributors must still inspect every diff before pushing.

## Supported security boundary

The intended deployment is owner-private. Publishing the relay or sharing its device credential changes the threat model and is not supported by the default configuration.

TeaDraw MCP intentionally does not expose arbitrary script execution or remote file opening. New tools should use fixed internal implementations, strict schemas, exact `document_id` targeting, and post-write verification.

## Reporting

For a vulnerability that could expose credentials or local files, use the repository's private GitHub Security Advisory workflow rather than a public issue. Revoke affected credentials before collecting logs, and redact bearer tokens, local paths, artwork, and document contents.
