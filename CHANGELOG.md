# Changelog

## Unreleased

**Highlights:** More reliable streamed answers, recovery from stalled requests, and OpenClaw ID sign-in.

- Keep streamed answers flowing when GitHub source paths contain malformed percent escapes, while preserving readable labels and line anchors. Thanks @SebTardif (#20).
- Keep streamed answers flowing past malformed JSON and non-text SSE events. Thanks @SebTardif (#10).
- Stream answers progressively with compact GitHub issue, PR, commit, and source citations instead of exposing workspace mirror paths.
- Bound stalled OpenAI chat and tool requests without cutting off healthy long-running answer streams. Thanks @SebTardif (#8).
- Recover from stalled docs, source, and GitHub retrieval requests instead of leaving chats pending. Thanks @SebTardif (#15).
- Keep source and GitHub context available during docs outages, with R2-backed docs retrieval and public-host fallbacks. Thanks @vyctorbrzezowski.
- Limit oversized corpus, index, and raw source reads while preserving multibyte source context. Thanks @SebTardif (#9).
- Sign in through OpenClaw ID with host-scoped docs sessions while continuing to accept existing GitHub session cookies.
- Bound stalled OpenClaw ID token exchanges and show a retryable verification timeout. Thanks @SebTardif (#14).
- Show the verification error page for malformed OIDC token JSON, null payloads, and non-string tokens. Thanks @SebTardif (#16).
- Support same-origin chat, sign-in, and GET/HEAD session checks across supported docs hosts, with trusted-origin checks and a dedicated session-signing secret.
- Publish the GitHub search index on the docs domain and mount individual GitHub records for more focused retrieval.
- Bound stalled public artifact proxy fetches and return a retryable timeout. Thanks @SebTardif (#18).
- Keep workspace exports reliable for large source indexes (#6).
- Refresh Cloudflare Worker tooling, type definitions, linting, formatting, and CI actions; document the current OpenClaw ID setup.
