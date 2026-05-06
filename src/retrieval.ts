import type { Env, SearchRecord, WorkspaceFile } from "./types";

const docsCorpusUrl = "https://documentation.openclaw.ai/llms-full.txt";
const sourceIndexUrl = "https://documentation.openclaw.ai/source-index.jsonl";
const githubIndexUrl = "https://documentation.openclaw.ai/ask-molty/github-search.jsonl";
const workspaceManifestUrl = "https://documentation.openclaw.ai/ask-molty/workspace-manifest.json";

export async function buildWorkspace(env: Env, query: string): Promise<WorkspaceFile[]> {
  const [docsCorpus, sourceIndex, githubIndex] = await Promise.all([
    loadText(env.DOCS_CORPUS_URL ?? docsCorpusUrl, 1000),
    loadText(env.SOURCE_INDEX_URL ?? sourceIndexUrl, 1000).catch(() => ""),
    loadText(env.GITHUB_INDEX_URL ?? githubIndexUrl, 1000).catch(() => ""),
  ]);
  const docs = docsRecordsFromCorpus(docsCorpus);
  const source = recordsFromJsonl(sourceIndex, "source");
  const github = recordsFromJsonl(githubIndex, "github");

  const docMatches = selectRecords(docs, query, 10);
  const sourceMatches = selectRecords(source, query, sourceSeeking(query) ? 10 : 5);
  const githubMatches = selectRecords(github, query, githubSeeking(query) ? 12 : 4);

  const files: WorkspaceFile[] = [];
  const githubSummary = githubSummaryFile(github, query);
  if (githubSummary) files.push(githubSummary);
  for (const record of docMatches) files.push(recordToWorkspaceFile(record));
  for (const record of sourceMatches) files.push(await sourceToWorkspaceFile(record));
  for (const record of githubMatches) files.push(githubToWorkspaceFile(record));
  return dedupeWorkspace(files).slice(0, 32);
}

export async function readWorkspaceArtifact(env: Env, workspacePath: string): Promise<string> {
  const manifest = await loadJson<WorkspaceManifest>(
    env.WORKSPACE_MANIFEST_URL ?? workspaceManifestUrl,
  ).catch(() => null);
  const entry = manifest?.files?.[workspacePath.replace(/^\/+/, "")];
  if (!entry?.url) throw new Error(`workspace file not found: ${workspacePath}`);
  return loadText(
    new URL(entry.url, manifest?.baseUrl ?? "https://documentation.openclaw.ai/").toString(),
    1,
  );
}

export function searchWorkspace(
  files: WorkspaceFile[],
  query: string,
  kind?: string,
  limit = 8,
): Array<{ path: string; kind: string; url?: string; snippet: string; score: number }> {
  const terms = tokenize(query);
  return files
    .filter((file) => !kind || file.kind === kind)
    .map((file) => ({
      file,
      score: scoreText(`${file.path}\n${file.url ?? ""}\n${file.content}`, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map(({ file, score }) => ({
      path: file.path,
      kind: file.kind,
      url: file.url,
      score,
      snippet: snippet(file.content, terms),
    }));
}

export function readWorkspace(files: WorkspaceFile[], path: string): WorkspaceFile | undefined {
  const normalized = normalizeWorkspacePath(path);
  return files.find((file) => normalizeWorkspacePath(file.path) === normalized);
}

export function workspaceContext(files: WorkspaceFile[]): string {
  return files
    .slice(0, 16)
    .map(
      (file) =>
        `Path: ${file.path}\nKind: ${file.kind}\nURL: ${file.url ?? ""}\n\n${file.content.slice(0, 1800)}`,
    )
    .join("\n\n---\n\n");
}

async function loadText(url: string, minLength: number): Promise<string> {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  const cached = await cache.match(key);
  if (cached?.ok) return cached.text();
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 300 } });
  if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
  const text = await response.text();
  if (text.startsWith("<!DOCTYPE html>") || text.length < minLength)
    throw new Error(`Invalid text from ${url}`);
  await cache.put(key, new Response(text, { headers: { "Cache-Control": "public, max-age=300" } }));
  return text;
}

async function loadJson<T>(url: string): Promise<T> {
  return JSON.parse(await loadText(url, 2)) as T;
}

function docsRecordsFromCorpus(corpus: string): SearchRecord[] {
  return corpus
    .split(/\n---\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const title = chunk.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Docs";
      const url = chunk.match(/^Source:\s+(.+)$/m)?.[1]?.trim();
      return {
        kind: "docs",
        path: `/docs/${slugify(title)}.md`,
        title,
        url,
        search: chunk,
      };
    });
}

function recordsFromJsonl(text: string, kind: SearchRecord["kind"]): SearchRecord[] {
  const records: SearchRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<SearchRecord>;
      if (parsed.path && parsed.search)
        records.push({ ...parsed, kind, path: parsed.path, search: parsed.search });
    } catch {
      // Ignore one malformed row.
    }
  }
  return records;
}

function selectRecords(records: SearchRecord[], query: string, limit: number): SearchRecord[] {
  const terms = tokenize(query);
  return records
    .map((record) => {
      const pathText = `${record.title ?? ""}\n${record.path}\n${record.url ?? ""}`.toLowerCase();
      const searchText = record.search.toLowerCase();
      const exactBonus = terms.reduce((score, term) => {
        const filenameBonus = term.includes("-") ? 1000 : 100;
        if (pathText.includes(term)) return score + filenameBonus + term.length;
        if (term.includes("-") && searchText.includes(term)) return score + 400 + term.length;
        return score;
      }, 0);
      return {
        record,
        score: exactBonus + scoreText(recordSearchText(record), terms),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.record);
}

function githubToWorkspaceFile(record: SearchRecord): WorkspaceFile {
  const type = githubRecordType(record);
  const issuePath = type === "pull request" ? "pr" : type;
  const path = record.number ? `/workspace/github/${issuePath}-${record.number}.md` : record.path;
  const labels = record.labels?.length ? `labels: ${record.labels.join(", ")}` : "";
  const files = record.files?.length ? `files: ${record.files.join(", ")}` : "";
  const frontmatter = [
    "---",
    `kind: github`,
    `github_type: ${yamlString(type)}`,
    record.title ? `title: ${yamlString(record.title)}` : "",
    record.number ? `number: ${record.number}` : "",
    record.state ? `state: ${record.state}` : "",
    record.url ? `url: ${record.url}` : "",
    labels,
    files,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    path,
    kind: "github",
    url: record.url,
    content:
      `${frontmatter}\n\n# ${type} #${record.number ?? ""}: ${record.title ?? record.path}\n\nGitHub: ${record.url ?? ""}\nState: ${record.state ?? ""}\n\n${record.search}`.slice(
        0,
        5000,
      ),
  };
}

function githubSummaryFile(records: SearchRecord[], query: string): WorkspaceFile | undefined {
  if (!wantsOpenPullRequestList(query)) return undefined;
  const openPullRequests = records
    .filter((record) => record.state === "open" && githubRecordType(record) === "pull request")
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  const displayed = openPullRequests.slice(0, 100);
  const lines = [
    "# Open GitHub pull requests",
    "",
    `Total open pull requests in indexed GitHub data: ${openPullRequests.length}.`,
    displayed.length < openPullRequests.length
      ? `Showing newest ${displayed.length}; ask for a narrower topic to search within all indexed PRs.`
      : "Showing all indexed open pull requests.",
    "",
    ...displayed.map(
      (record) => `- PR #${record.number} — ${record.title ?? "(untitled)"}\n  ${record.url ?? ""}`,
    ),
  ];
  return {
    path: "/workspace/github/open-pull-requests.md",
    kind: "github",
    content: lines.join("\n"),
  };
}

function recordToWorkspaceFile(record: SearchRecord): WorkspaceFile {
  const frontmatter = [
    "---",
    `kind: ${record.kind}`,
    record.title ? `title: ${yamlString(record.title)}` : "",
    record.number ? `number: ${record.number}` : "",
    record.state ? `state: ${record.state}` : "",
    record.url ? `url: ${record.url}` : "",
    record.commit ? `commit: ${record.commit}` : "",
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    path: record.workspacePath ?? record.path,
    kind: record.kind,
    url: record.url,
    content: `${frontmatter}\n\n# ${record.title ?? record.path}\n\n${record.search}`.slice(
      0,
      5000,
    ),
  };
}

async function sourceToWorkspaceFile(record: SearchRecord): Promise<WorkspaceFile> {
  if (!record.rawUrl) return recordToWorkspaceFile(record);
  const raw = await loadText(record.rawUrl, 1).catch(() => "");
  const body = raw ? fencedSource(record.path, raw.slice(0, 12_000)) : record.search;
  return {
    path: record.workspacePath ?? `/source/${flatPath(record.path)}.md`,
    kind: "source",
    url: record.url,
    content: `---\nkind: source\npath: ${record.path}\nurl: ${record.url ?? ""}\ncommit: ${record.commit ?? ""}\n---\n\n# ${record.path}\n\n${body}`,
  };
}

function fencedSource(path: string, content: string): string {
  return `\`\`\`${languageForPath(path)}\n${content}\n\`\`\``;
}

function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const hits = lower.split(term).length - 1;
    if (hits) score += Math.min(12, hits) * (term.length > 5 ? 3 : 1);
    if (lower.slice(0, 500).includes(term)) score += term.length > 5 ? 12 : 6;
  }
  return score;
}

function recordSearchText(record: SearchRecord): string {
  return [
    record.title,
    record.path,
    record.url,
    record.kind === "github" ? githubRecordType(record) : "",
    record.kind === "github" && githubRecordType(record) === "pull request"
      ? "pr prs pull request"
      : "",
    record.state,
    record.labels?.join(" "),
    record.files?.join(" "),
    record.search,
  ]
    .filter(Boolean)
    .join("\n");
}

function githubRecordType(record: SearchRecord): "issue" | "pull request" {
  return record.url?.includes("/pull/") || /#pr-\d+/.test(record.path) ? "pull request" : "issue";
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let index = 0;
  for (const term of terms) {
    const hit = lower.indexOf(term);
    if (hit >= 0) {
      index = hit;
      break;
    }
  }
  const start = Math.max(0, index - 220);
  return text
    .slice(start, start + 700)
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(input: string): string[] {
  const terms: string[] = input.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
  if (/\b(pr|prs|pull request|pull requests)\b/i.test(input)) terms.push("pr", "pull", "request");
  if (/\b(issue|issues)\b/i.test(input)) terms.push("issue");
  return [...new Set(terms)]
    .filter(
      (term) =>
        ![
          "and",
          "cite",
          "code",
          "contains",
          "does",
          "exact",
          "exactly",
          "file",
          "files",
          "for",
          "github",
          "how",
          "link",
          "list",
          "list-workspace",
          "mounted",
          "molty",
          "only",
          "openclaw",
          "output",
          "path",
          "paths",
          "report",
          "run",
          "source",
          "the",
          "use",
          "what",
          "which",
          "with",
          "workspace",
        ].includes(term),
    )
    .slice(0, 24);
}

function sourceSeeking(input: string): boolean {
  return /\b(source|code|file|implementation|implemented|class|function|api|where|github|commit)\b/i.test(
    input,
  );
}

function githubSeeking(input: string): boolean {
  return /\b(issue|issues|pr|pull request|pull requests|bug|known|fixed|closed|merged|regression|discussion|comment|commit|github|#\d+)\b/i.test(
    input,
  );
}

function wantsOpenPullRequestList(input: string): boolean {
  return /\bopen\b/i.test(input) && /\b(pr|prs|pull request|pull requests)\b/i.test(input);
}

function dedupeWorkspace(files: WorkspaceFile[]): WorkspaceFile[] {
  const seen = new Set<string>();
  const out: WorkspaceFile[] = [];
  for (const file of files) {
    const key = normalizeWorkspacePath(file.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function normalizeWorkspacePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/^workspace\/?/, "")
    .replace(/\/+/g, "/");
}

function flatPath(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "__");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "page"
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function languageForPath(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return ext === path ? "text" : ext;
}

interface WorkspaceManifest {
  baseUrl?: string;
  files?: Record<string, { url: string; bytes?: number; sha256?: string; kind?: string }>;
}
