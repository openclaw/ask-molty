# Changelog

## Unreleased

- Recover from stalled docs, source, and GitHub retrieval requests instead of leaving chats pending. Thanks @SebTardif (#15).
- Keep streamed answers flowing past malformed JSON and non-text SSE events. Thanks @SebTardif (#10).
- Bound stalled OpenClaw ID token exchanges and show a retryable verification timeout. Thanks @SebTardif (#14).
