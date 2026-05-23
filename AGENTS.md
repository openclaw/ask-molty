# AGENTS.MD

Docs AI worker. Keep this repo about Ask Molty runtime, prompt, retrieval, auth,
and workspace export. Docs publishing lives in `openclaw/docs`; source docs live
in `openclaw/openclaw:docs/**`.

## Map

- Worker: `src/worker.ts`.
- Prompt: `src/prompt.ts`.
- Retrieval/VFS: `src/retrieval.ts`.
- Types: `src/types.ts`.
- Workspace export: `scripts/export-workspace.ts`.
- Smoke: `scripts/smoke.ts`.

## Docs System

- Public docs host: `https://docs.openclaw.ai`.
- Chat route: `/ask-molty/*` to this Worker.
- Source docs flow: `openclaw/openclaw:docs/**` -> `docs-sync-publish.yml` -> `openclaw/docs` -> R2 -> Worker router.
- Ask Molty artifacts publish under `/ask-molty/`.
- Default artifact files: `docs-search.jsonl`, `source-search.jsonl`, `github-search.jsonl`, `workspace-manifest.json`, `workspace/**`.

## Workspace

- Exporter builds read-only `/workspace/{docs,source,github}` markdown files.
- Worker does not mount whole workspace per request; it loads indexes, ranks candidates, then mounts selected files.
- Docs are canonical. Source is implementation truth. GitHub issues/PRs are discussion/status evidence.
- GitHub data comes from Gitcrawl SQLite (`ASK_MOLTY_GITCRAWL_DB`), not live GitHub inside the Worker.
- Source files use raw GitHub URLs for on-demand exact reads.

## Tools

- Model tools: `search_workspace`, `read_workspace`, `list_workspace`, `run_shell`.
- `run_shell` is fake/read-only only: `rg`, `grep`, `cat`, `head`, `ls`, `find`.
- No network, writes, pipes, redirects, process execution, or broad filesystem access.
- GitHub mirror paths are private implementation detail; final answers cite GitHub issue/PR URLs.

## Commands

- Install: `npm install`.
- Check: `npm run check`.
- Export real workspace: `npm run export`.
- Deploy Worker: `npm run deploy`.
- Formatting: `npm run format`; check with `npm run format:check`.

## Change Rules

- Retrieval/tool/prompt behavior: update `src/retrieval.ts`, `src/worker.ts`, `src/prompt.ts`, and smoke/tests together when needed.
- Export schema changes: update `scripts/export-workspace.ts`, `src/types.ts`, `src/retrieval.ts`, and `scripts/smoke.ts`.
- Auth/session changes: keep GitHub verification and cookie signing server-side; never log secrets.
- New artifact paths: update `artifactUrls`, `wrangler.toml` vars, README, and smoke.
