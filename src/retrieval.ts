import type { Env, SearchRecord, WorkspaceFile } from "./types";

const docsCorpusUrl = "https://docs.openclaw.ai/llms-full.txt";
const docsCorpusFallbackUrl = "https://docs.openclaw.ai/.well-known/llms-full.txt";
const docsSearchIndexUrl = "https://docs.openclaw.ai/docs-search.json";
const sourceIndexUrl = "https://docs.openclaw.ai/source-index.jsonl";
const githubIndexUrl =
  "https://github.com/openclaw/ask-molty/releases/download/workspace-latest/github-search.jsonl";
const workspaceManifestUrl = "https://docs.openclaw.ai/ask-molty/workspace-manifest.json";
const loadTextRetryDelaysMs = [150, 450];
export const maxWorkspaceTextBytes = 16_000_000;
export const maxJsonlStreamBytes = 24_000_000;
export const maxSourceRawChars = 12_000;
// A valid UTF-8 scalar needs at most three bytes per UTF-16 code unit.
export const maxSourceRawBytes = maxSourceRawChars * 3;

interface RecordSelection {
  matches: SearchRecord[];
  summaryRecords: SearchRecord[];
  parsedRecords: number;
}

export async function buildWorkspace(env: Env, query: string): Promise<WorkspaceFile[]> {
  const sourceLimit = sourceSeeking(query) ? 10 : 5;
  const githubLimit = githubSeeking(query) ? 12 : 4;
  const [docsResult, sourceSelection, githubSelection] = await Promise.all([
    loadDocsRecords(env).catch(() => ({ records: [], usesSearchIndex: false })),
    loadSearchSelection(
      env,
      "source-index.jsonl",
      env.SOURCE_INDEX_URL ?? sourceIndexUrl,
      "source",
      query,
      sourceLimit,
    ),
    loadSearchSelection(
      env,
      null,
      env.GITHUB_INDEX_URL ?? githubIndexUrl,
      "github",
      query,
      githubLimit,
    ),
  ]);

  let docs = docsResult.records;
  let docMatches = selectRecords(docs, query, 10);
  const sourceMatches = sourceSelection.matches;
  const githubMatches = githubSelection.matches;
  if (
    !docMatches.length &&
    !sourceMatches.length &&
    !githubMatches.length &&
    docsResult.usesSearchIndex
  ) {
    const corpusDocs = await loadDocsCorpus(env)
      .then((corpus) => docsRecordsFromCorpus(corpus))
      .catch(() => []);
    const corpusMatches = selectRecords(corpusDocs, query, 10);
    if (corpusMatches.length) {
      docs = corpusDocs;
      docMatches = corpusMatches;
    }
  }

  const files: WorkspaceFile[] = [];
  if (!docs.length) files.push(docsUnavailableFile());
  const githubSummary = githubSummaryFile(githubSelection.summaryRecords, query);
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
    new URL(entry.url, manifest?.baseUrl ?? "https://docs.openclaw.ai/").toString(),
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
      path: displayPath(file),
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
        `${displayPathLabel(file)}\nKind: ${file.kind}\nURL: ${file.url ?? ""}\n\n${file.content.slice(0, 1800)}`,
    )
    .join("\n\n---\n\n");
}

async function loadText(
  url: string,
  minLength: number,
  retryDelaysMs: readonly number[] = [],
): Promise<string> {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  const cached = await cache.match(key);
  if (cached?.ok) return readCappedText(cached, url, maxWorkspaceTextBytes, "strict");
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 300 } });
      if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
      const text = await readCappedText(response, url, maxWorkspaceTextBytes, "strict");
      if (text.startsWith("<!DOCTYPE html>") || text.length < minLength)
        throw new Error(`Invalid text from ${url}`);
      await cache.put(
        key,
        new Response(text, { headers: { "Cache-Control": "public, max-age=300" } }),
      );
      return text;
    } catch (error) {
      lastError = error;
      if (isByteCapError(error)) break;
      const delay = retryDelaysMs[attempt];
      if (delay) await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to load ${url}`);
}

async function loadTextPrefix(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 300 } });
  if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
  return readCappedText(response, url, maxBytes, "prefix");
}

async function readCappedText(
  response: Response,
  url: string,
  maxBytes: number,
  mode: "strict" | "prefix",
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (mode === "strict" && Number.isFinite(declared) && declared > maxBytes) {
    throw byteCapError(url, maxBytes);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= maxBytes) return text;
    if (mode === "prefix") return new TextDecoder().decode(bytes.subarray(0, maxBytes));
    throw byteCapError(url, maxBytes);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      if (mode === "prefix" && remaining > 0) chunks.push(value.subarray(0, remaining));
      await reader.cancel();
      if (mode === "prefix") return decodeUtf8(chunks);
      throw byteCapError(url, maxBytes);
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return decodeUtf8(chunks);
}

function byteCapError(url: string, maxBytes: number): Error {
  return new Error(`Text from ${url} exceeds ${maxBytes} bytes`);
}

function isByteCapError(error: unknown): boolean {
  return error instanceof Error && / exceeds \d+ bytes$/.test(error.message);
}

function decodeUtf8(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function loadDocsCorpus(env: Env): Promise<string> {
  const stored = await loadR2Text(env, "llms-full.txt", 1000);
  if (stored) return stored;
  for (const url of uniqueUrls(env.DOCS_CORPUS_URL, docsCorpusUrl, docsCorpusFallbackUrl)) {
    try {
      return await loadText(url, 1000, loadTextRetryDelaysMs);
    } catch (error) {
      console.warn("docs corpus fetch failed", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error("Docs corpus is temporarily unavailable. Please retry in a moment.");
}

async function loadDocsRecords(env: Env): Promise<DocsRecordSet> {
  const stored = await loadR2Text(env, "docs-search.json", 1000);
  if (stored) {
    try {
      return {
        records: docsRecordsFromSearchIndex(stored, "https://docs.openclaw.ai"),
        usesSearchIndex: true,
      };
    } catch (error) {
      console.warn("stored docs search index invalid", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const indexUrl of uniqueUrls(env.DOCS_INDEX_URL, docsSearchIndexUrl)) {
    try {
      return {
        records: docsRecordsFromSearchIndex(
          await loadText(indexUrl, 1000, loadTextRetryDelaysMs),
          new URL(indexUrl).origin,
        ),
        usesSearchIndex: true,
      };
    } catch (error) {
      console.warn("docs search index fetch failed", {
        url: indexUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    records: docsRecordsFromCorpus(await loadDocsCorpus(env)),
    usesSearchIndex: false,
  };
}

async function loadSearchSelection(
  env: Env,
  objectKey: string | null,
  url: string,
  kind: SearchRecord["kind"],
  query: string,
  limit: number,
): Promise<RecordSelection> {
  if (objectKey && env.DOCS_ARTIFACTS) {
    try {
      const object = await env.DOCS_ARTIFACTS.get(objectKey);
      if (object && object.size >= 1000) {
        const selection = await selectJsonlStream(object.body, kind, query, limit);
        if (selection.parsedRecords > 0) return selection;
        console.warn("stored search index has no usable records", { objectKey });
      }
    } catch (error) {
      console.warn("stored search index failed", {
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const response = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 300 } });
    if (!response.ok || !response.body)
      throw new Error(`Unable to load ${url}: ${response.status}`);
    const selection = await selectJsonlStream(response.body, kind, query, limit);
    if (selection.parsedRecords > 0) return selection;
    console.warn("search index has no usable records", { url });
  } catch (error) {
    console.warn("search index fetch failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { matches: [], summaryRecords: [], parsedRecords: 0 };
}

async function loadR2Text(env: Env, key: string, minLength: number): Promise<string | null> {
  if (!env.DOCS_ARTIFACTS) return null;
  try {
    const object = await env.DOCS_ARTIFACTS.get(key);
    if (!object) return null;
    if (object.size > maxWorkspaceTextBytes) {
      console.warn("stored retrieval artifact exceeds cap", { key, size: object.size });
      return null;
    }
    const text = await object.text();
    if (text.startsWith("<!DOCTYPE html>") || text.length < minLength) return null;
    return text;
  } catch (error) {
    console.warn("stored retrieval artifact failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function uniqueUrls(...urls: Array<string | undefined>): string[] {
  return [...new Set(urls.filter((url): url is string => Boolean(url)))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadJson<T>(url: string): Promise<T> {
  return JSON.parse(await loadText(url, 2)) as T;
}

function docsRecordsFromSearchIndex(text: string, origin: string): SearchRecord[] {
  const parsed = JSON.parse(text) as Partial<DocsSearchIndex>;
  if (!Array.isArray(parsed.entries)) throw new Error("Invalid docs search index");
  const records = parsed.entries
    .map((entry) => docsSearchEntryToRecord(entry, origin))
    .filter((record): record is SearchRecord => Boolean(record));
  if (!records.length) throw new Error("Docs search index has no usable entries");
  return records;
}

function docsSearchEntryToRecord(entry: DocsSearchEntry, origin: string): SearchRecord | undefined {
  if (!entry.url || !entry.search) return undefined;
  const url = new URL(entry.url, origin).toString();
  const title = entry.title || titleFromRoute(entry.url);
  return {
    kind: "docs",
    path: `/docs/${flatPath(entry.url.replace(/^\/+/, "") || "index")}.md`,
    title,
    url,
    search: [title, entry.snippet, entry.search].filter(Boolean).join("\n\n"),
  };
}

function titleFromRoute(value: string): string {
  const base = value.replace(/\/$/u, "").split("/").pop() || "Docs";
  return base
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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

function docsUnavailableFile(): WorkspaceFile {
  return {
    path: "/workspace/docs/unavailable.md",
    kind: "docs",
    content:
      "# Docs unavailable\n\nThe OpenClaw docs index could not be loaded for this answer. If the question needs documentation context, tell the user Molty cannot load the docs right now and ask them to retry in a moment. Do not invent documentation details.",
  };
}

async function selectJsonlStream(
  stream: ReadableStream<Uint8Array>,
  kind: SearchRecord["kind"],
  query: string,
  limit: number,
): Promise<RecordSelection> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const terms = tokenize(query);
  const ranked: Array<{ record: SearchRecord; score: number }> = [];
  const summaryRecords: SearchRecord[] = [];
  let parsedRecords = 0;
  let buffer = "";

  const processLine = (line: string) => {
    const record = parseJsonlRecord(line, kind);
    if (!record) return;
    parsedRecords += 1;
    if (
      kind === "github" &&
      wantsOpenPullRequestList(query) &&
      record.state === "open" &&
      githubRecordType(record) === "pull request"
    ) {
      summaryRecords.push(record);
    }
    const score = recordScore(record, terms);
    if (score <= 0) return;
    ranked.push({ record, score });
    if (ranked.length > limit * 4) {
      ranked.sort((a, b) => b.score - a.score);
      ranked.length = limit;
    }
  };

  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      if (totalBytes > maxJsonlStreamBytes || buffer.length > 1_048_576) {
        const lines = buffer.split("\n");
        lines.pop();
        for (const line of lines) processLine(line);
        buffer = "";
        break;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    if (buffer) {
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  ranked.sort((a, b) => b.score - a.score);
  return {
    matches: ranked.slice(0, limit).map((item) => item.record),
    summaryRecords,
    parsedRecords,
  };
}

function parseJsonlRecord(line: string, kind: SearchRecord["kind"]): SearchRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Partial<SearchRecord>;
    if (!parsed.path || !parsed.search) return null;
    return { ...parsed, kind, path: parsed.path, search: parsed.search };
  } catch {
    return null;
  }
}

function selectRecords(records: SearchRecord[], query: string, limit: number): SearchRecord[] {
  const terms = tokenize(query);
  return records
    .map((record) => ({ record, score: recordScore(record, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.record);
}

function recordScore(record: SearchRecord, terms: string[]): number {
  const pathText = `${record.title ?? ""}\n${record.path}\n${record.url ?? ""}`.toLowerCase();
  const searchText = record.search.toLowerCase();
  const exactBonus = terms.reduce((score, term) => {
    const filenameBonus = term.includes("-") ? 1000 : 100;
    if (pathText.includes(term)) return score + filenameBonus + term.length;
    if (term.includes("-") && searchText.includes(term)) return score + 400 + term.length;
    return score;
  }, 0);
  return exactBonus + scoreText(recordSearchText(record), terms);
}

function githubToWorkspaceFile(record: SearchRecord): WorkspaceFile {
  const type = githubRecordType(record);
  const issuePath = type === "pull request" ? "pr" : type;
  const path = record.number ? `/workspace/github/${issuePath}-${record.number}.md` : record.path;
  const label = githubLinkLabel(record);
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
      `${frontmatter}\n\n# ${label}: ${record.title ?? record.path}\n\nGitHub: ${markdownLink(label, record.url)}\nState: ${record.state ?? ""}\n\n${record.search}`.slice(
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
      (record) =>
        `- ${markdownLink(githubLinkLabel(record), record.url)} — ${record.title ?? "(untitled)"}`,
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
  const raw = await loadTextPrefix(record.rawUrl, maxSourceRawBytes).catch(() => "");
  const body = raw ? fencedSource(record.path, raw.slice(0, maxSourceRawChars)) : record.search;
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

function githubLinkLabel(record: SearchRecord): string {
  const fallback = record.title ?? record.path;
  if (!record.number) return fallback;
  return githubRecordType(record) === "pull request"
    ? `PR #${record.number}`
    : `Issue #${record.number}`;
}

function markdownLink(label: string, url?: string): string {
  return url ? `[${label}](${url})` : label;
}

function githubUrlLabel(url?: string): string {
  if (!url) return "";
  const issue = url.match(/\/issues\/(\d+)\/?$/)?.[1];
  if (issue) return markdownLink(`Issue #${issue}`, url);
  const pullRequest = url.match(/\/pull\/(\d+)\/?$/)?.[1];
  if (pullRequest) return markdownLink(`PR #${pullRequest}`, url);
  const commit = url.match(/\/commit\/([0-9a-f]{7,40})\/?$/i)?.[1];
  if (commit) return markdownLink(`commit ${commit.slice(0, 7)}`, url);
  return url;
}

function displayPath(file: WorkspaceFile): string {
  return file.kind === "github" && file.url ? file.url : file.path;
}

function displayPathLabel(file: WorkspaceFile): string {
  return file.kind === "github" ? `GitHub: ${githubUrlLabel(file.url)}` : `Path: ${file.path}`;
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

interface DocsRecordSet {
  records: SearchRecord[];
  usesSearchIndex: boolean;
}

interface DocsSearchIndex {
  entries?: DocsSearchEntry[];
}

interface DocsSearchEntry {
  search?: string;
  snippet?: string;
  title?: string;
  url?: string;
}
