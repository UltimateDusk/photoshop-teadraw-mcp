# Architecture

TeaDraw MCP has three trust zones:

```mermaid
sequenceDiagram
    participant AI as Chat / Work AI
    participant Relay as Owner-private cloud relay
    participant Bridge as Windows TeaDraw bridge
    participant PS as Photoshop MCP + Photoshop

    AI->>Relay: MCP tool call with document_id/revision
    Relay->>Relay: Validate curated schema
    Bridge->>Relay: Poll authenticated device queue
    Relay-->>Bridge: Short-lived job
    Bridge->>PS: Curated STDIO call or fixed internal script
    PS-->>Bridge: Structured result / preview
    Bridge->>Relay: Result
    Relay-->>AI: Structured JSON and optional image
```

## Cloud relay

The relay validates all tool arguments before a job reaches the device. It does not contain Photoshop credentials and cannot open local files by path. R2 records expire and are removed after completion.

## Windows bridge

The bridge makes outbound HTTPS requests only. It does not listen on a public network interface. Its device credential is DPAPI-encrypted and the service origin is pinned to the hostname stored inside that encrypted configuration.

The bridge exposes fixed internal ExtendScript snippets for operations that the upstream MCP does not provide directly. No caller-controlled script text is accepted.

## Revision engine

`collab-runtime.cjs` samples short read-only signatures outside Photoshop's main scripting call. A long poll repeatedly performs short samples instead of running a sleeping ExtendScript program, so Photoshop remains interactive.

Each observed signature can advance a persisted monotonic revision. A wait cursor prevents duplicate delivery, while `expected_revision` protects edits from stale visual context.

## Preview flow

Full and region previews are generated as temporary JPEG files on the device. The bridge reads them into the MCP image result and deletes the temporary file before returning. Region previews are capped to stay below the relay result-size limit.
