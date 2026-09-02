# Changelog

## Unreleased

- Bound stalled public artifact proxy fetches and return a retryable timeout. Thanks @SebTardif.
- Recover from stalled docs, source, and GitHub retrieval requests instead of leaving chats pending. Thanks @SebTardif (#15).
- Keep streamed answers flowing past malformed JSON and non-text SSE events. Thanks @SebTardif (#10).
- Bound stalled OpenClaw ID token exchanges and show a retryable verification timeout. Thanks @SebTardif (#14).
- Show the verification error page for malformed OIDC token JSON, null payloads, and non-string tokens. Thanks @SebTardif (#16).
