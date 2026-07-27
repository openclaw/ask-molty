#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type SearchKind = "docs" | "github" | "source";
type SqlRow = Record<string, any>;

interface ManifestFile {
  bytes: number;
  kind: string;
  sha256: string;
  url: string;
}

interface Manifest {
  baseUrl: string;
  docsOrigin: string;
  files: Record<string, ManifestFile>;
  generatedAt: string;
  gitcrawl: {
    db: string;
    storeCommit: string;
  };
  source: {
    repository: string;
    sha: string;
  };
}

interface SearchRecord {
  commit?: string;
  files?: string[];
  kind: SearchKind;
  labels?: string[];
  number?: number;
  path: string;
  rawUrl?: string;
  search: string;
  state?: string;
  title?: string;
  url?: string;
  workspacePath: string;
}

const cwd = process.cwd();
const outDir = path.resolve(process.env.ASK_MOLTY_OUT_DIR ?? path.join(cwd, "dist", "ask-molty"));
const docsRepo = path.resolve(
  process.env.ASK_MOLTY_DOCS_REPO ?? path.join(cwd, "..", "docs-openclaw"),
);
const sourceRepo = path.resolve(
  process.env.ASK_MOLTY_SOURCE_REPO ?? path.join(cwd, "..", "clawdbot5"),
);
const gitcrawlStore = path.resolve(
  process.env.ASK_MOLTY_GITCRAWL_STORE ??
    path.join(os.homedir(), ".config", "gitcrawl", "stores", "gitcrawl-store"),
);
const gitcrawlDb = path.resolve(
  process.env.ASK_MOLTY_GITCRAWL_DB ??
    path.join(gitcrawlStore, "data", "openclaw__openclaw.sync.db"),
);
const docsOrigin = (process.env.ASK_MOLTY_DOCS_ORIGIN ?? "https://docs.openclaw.ai").replace(
  /\/$/,
  "",
);
const sourceRepoUrl = (
  process.env.ASK_MOLTY_SOURCE_REPO_URL ?? "https://github.com/openclaw/openclaw"
).replace(/\/$/, "");
const githubRepo = process.env.ASK_MOLTY_GITHUB_REPO ?? "openclaw/openclaw";
const maxSourceBytes = Number(process.env.ASK_MOLTY_MAX_SOURCE_BYTES ?? 180_000);
const maxSearchChars = 900;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const manifest: Manifest = {
  generatedAt: new Date().toISOString(),
  baseUrl: `${docsOrigin}/ask-molty/`,
  docsOrigin,
  source: {
    repository: githubRepo,
    sha: sourceSha(),
  },
  gitcrawl: {
    storeCommit: gitDirExists(gitcrawlStore) ? git(gitcrawlStore, ["rev-parse", "HEAD"]) : "",
    db: gitcrawlDb,
  },
  files: {},
};

const docsRecords = exportDocs();
const sourceRecords = exportSource();
const githubRecords = exportGithub();
writeJsonl("docs-search.jsonl", docsRecords);
writeJsonl("source-search.jsonl", sourceRecords);
writeJsonl("github-search.jsonl", githubRecords);
writeJson("workspace-manifest.json", manifest);

console.log(`docs records: ${docsRecords.length}`);
console.log(`source records: ${sourceRecords.length}`);
console.log(`github records: ${githubRecords.length}`);
console.log(`output: ${path.relative(cwd, outDir)}`);
console.log(sizeSummary());

function exportDocs(): SearchRecord[] {
  const docsDir = path.join(docsRepo, "docs");
  if (!fs.existsSync(docsDir)) return [];
  const records: SearchRecord[] = [];
  for (const file of walk(docsDir)) {
    const rel = path.relative(docsDir, file).replaceAll(path.sep, "/");
    if (!/\.(md|mdx)$/.test(rel) || rel.includes("/.i18n/") || isLocaleDoc(rel)) continue;
    if (rel === "docs.json" || rel.endsWith("/AGENTS.md")) continue;
    const raw = fs.readFileSync(file, "utf8");
    const body = stripFrontmatter(raw);
    const title = firstHeading(body) ?? titleize(path.basename(rel, path.extname(rel)));
    const slug = rel.replace(/\.(md|mdx)$/, "").replace(/\/index$/, "") || "index";
    const route = slug === "index" ? "/" : `/${slug}`;
    const workspacePath = `workspace/docs/${flatPath(slug)}.md`;
    const content =
      frontmatter({
        kind: "docs",
        title,
        source: `${docsOrigin}${route}`,
        path: rel,
      }) + `\n# ${title}\n\n${body.trim()}\n`;
    writeWorkspaceFile(workspacePath, content, "docs");
    records.push({
      kind: "docs",
      path: `/${workspacePath}`,
      workspacePath: `/${workspacePath}`,
      title,
      url: `${docsOrigin}${route}`,
      search: compactSearch(`${title}\n${body}`),
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function exportSource(): SearchRecord[] {
  if (!gitDirExists(sourceRepo)) return [];
  const sha = manifest.source.sha;
  const records: SearchRecord[] = [];
  for (const rel of git(sourceRepo, ["ls-files"])
    .split("\n")
    .filter(Boolean)
    .sort(compareSourcePriority)) {
    if (!shouldIncludeSource(rel)) continue;
    const file = path.join(sourceRepo, rel);
    const stat = safeStat(file);
    if (!stat?.isFile() || stat.size > maxSourceBytes) continue;
    const raw = fs.readFileSync(file, "utf8");
    if (raw.includes("\0") || !raw.trim()) continue;
    const url = `${sourceRepoUrl}/blob/${sha}/${encodeURI(rel)}`;
    const rawUrl = rawUrlFor(sourceRepoUrl, sha, rel);
    const workspacePath = `workspace/source/${flatPath(rel)}.md`;
    const content =
      frontmatter({
        kind: "source",
        path: rel,
        source: url,
        raw: rawUrl,
        commit: `${sourceRepoUrl}/commit/${sha}`,
      }) + `\n# ${rel}\n\n\`\`\`${languageForPath(rel)}\n${raw}\n\`\`\`\n`;
    writeWorkspaceFile(workspacePath, content, "source");
    records.push({
      kind: "source",
      path: rel,
      workspacePath: `/${workspacePath}`,
      url,
      rawUrl,
      commit: `${sourceRepoUrl}/commit/${sha}`,
      search: sourceSearch(rel, raw),
    });
  }
  return records;
}

function exportGithub(): SearchRecord[] {
  if (!fs.existsSync(gitcrawlDb)) return [];
  const threadColumns = new Set(
    sqlite<{ name: string }>("pragma table_info(threads)").map((column) => column.name),
  );
  const threadBodyExpr = threadColumns.has("body")
    ? "coalesce(t.body_excerpt, t.body, '')"
    : "coalesce(t.body_excerpt, '')";
  const threadBodyLengthExpr = threadColumns.has("body")
    ? "coalesce(t.body_length, length(coalesce(t.body, '')))"
    : "coalesce(t.body_length, length(coalesce(t.body_excerpt, '')))";
  const rows = sqlite<SqlRow>(`
select t.id, t.number, t.kind, t.state, t.title,
  ${threadBodyExpr} as body,
  ${threadBodyLengthExpr} as bodyLength,
  t.author_login as author, t.html_url as url, t.labels_json as labelsJson,
  t.assignees_json as assigneesJson, t.is_draft as isDraft,
  t.created_at_gh as createdAt, t.updated_at_gh as updatedAt,
  t.closed_at_gh as closedAt, t.merged_at_gh as mergedAt
from threads t
join repositories r on r.id = t.repo_id
where r.full_name = ${sql(githubRepo)}
order by t.number asc
`);
  const ids = rows.map((row: SqlRow) => row.id);
  const comments = groupBy(
    sqlite<SqlRow>(`
select thread_id as threadId, comment_type as type, author_login as author,
  substr(body, 1, 700) as body, created_at_gh as createdAt, updated_at_gh as updatedAt
from comments
where thread_id in (${ids.join(",") || "null"})
order by coalesce(updated_at_gh, created_at_gh) desc
`),
    "threadId",
  );
  const files = groupBy(
    sqlite<SqlRow>(`
select thread_id as threadId, path, status, additions, deletions
from pull_request_files
where thread_id in (${ids.join(",") || "null"})
order by changes desc, path asc
`),
    "threadId",
  );
  const commits = groupBy(
    sqlite<SqlRow>(`
select thread_id as threadId, sha, substr(message, 1, 220) as message, html_url as url, committed_at as committedAt
from pull_request_commits
where thread_id in (${ids.join(",") || "null"})
order by committed_at desc
`),
    "threadId",
  );

  const records: SearchRecord[] = [];
  const shards = new Map<string, string[]>();
  for (const row of rows) {
    const kindName = row.kind === "pull_request" ? "pr" : "issue";
    const labels = labelsFromJson(row.labelsJson);
    const threadComments = (comments.get(row.id) ?? []).slice(0, 16);
    const threadFiles = (files.get(row.id) ?? []).slice(0, 80);
    const threadCommits = (commits.get(row.id) ?? []).slice(0, 30);
    const md = githubMarkdown(row, labels, threadComments, threadFiles, threadCommits);
    const shard = String(Math.floor(Number(row.number) / 1000)).padStart(3, "0");
    const workspacePath = `workspace/github/${shard}.md`;
    const shardEntries = shards.get(shard) ?? [];
    shardEntries.push(md);
    shards.set(shard, shardEntries);
    records.push({
      kind: "github",
      path: `/${workspacePath}#${kindName}-${row.number}`,
      workspacePath: `/${workspacePath}`,
      number: Number(row.number),
      state: row.state,
      title: row.title,
      url: row.url,
      labels,
      files: threadFiles.slice(0, 12).map((file: SqlRow) => String(file.path ?? "")),
      search: compactSearch(
        [
          row.title,
          row.body,
          labels.join(" "),
          threadComments
            .slice(0, 4)
            .map((comment: SqlRow) => `${comment.author}: ${comment.body}`)
            .join("\n"),
          threadFiles
            .slice(0, 12)
            .map((file: SqlRow) => file.path)
            .join(" "),
          threadCommits
            .slice(0, 5)
            .map((commit: SqlRow) => `${commit.sha} ${commit.message}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    });
  }
  for (const [shard, entries] of shards) {
    writeWorkspaceFile(
      `workspace/github/${shard}.md`,
      `${entries.join("\n\n---\n\n")}\n`,
      "github",
    );
  }
  return records;
}

function githubMarkdown(
  row: SqlRow,
  labels: string[],
  comments: SqlRow[],
  files: SqlRow[],
  commits: SqlRow[],
): string {
  const kindName = row.kind === "pull_request" ? "PR" : "Issue";
  return (
    frontmatter({
      kind: row.kind,
      number: row.number,
      state: row.state,
      title: row.title,
      source: row.url,
      updated_at: row.updatedAt,
    }) +
    `
# ${kindName} #${row.number}: ${row.title}

URL: ${row.url}
State: ${row.state}
Author: ${row.author ?? ""}
Labels: ${labels.join(", ")}
Created: ${row.createdAt ?? ""}
Updated: ${row.updatedAt ?? ""}
Closed: ${row.closedAt ?? ""}
Merged: ${row.mergedAt ?? ""}

## Body

${clean(row.body).slice(0, 1800)}

## Recent comments

${comments.map((comment) => `### ${comment.author ?? "unknown"} (${comment.type})\n\n${clean(comment.body)}`).join("\n\n")}

## Files

${files.map((file) => `- ${file.path} (${file.status ?? "modified"}, +${file.additions ?? 0}/-${file.deletions ?? 0})`).join("\n")}

## Commits

${commits.map((commit) => `- [${String(commit.sha).slice(0, 12)}](${commit.url}) ${clean(commit.message)}`).join("\n")}
`.trim()
  );
}

function writeWorkspaceFile(rel: string, content: string, kind: string): void {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  const bytes = Buffer.byteLength(content);
  manifest.files[rel] = {
    kind,
    bytes,
    sha256: createHash("sha256").update(content).digest("hex"),
    url: rel,
  };
}

function writeJsonl(rel: string, records: SearchRecord[]): void {
  const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  writeFile(rel, content);
}

function writeJson(rel: string, value: unknown): void {
  writeFile(rel, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(rel: string, content: string): void {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function shouldIncludeSource(rel: string): boolean {
  if (rel.startsWith("docs/") || rel.startsWith("vendor/") || rel.startsWith(".git/")) return false;
  if (
    rel
      .split("/")
      .some((part) =>
        ["node_modules", "dist", "coverage", ".turbo", ".next", "__snapshots__"].includes(part),
      )
  )
    return false;
  if (
    ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "AGENTS.md", "CLAUDE.md"].includes(
      path.basename(rel),
    )
  )
    return false;
  return (
    /\.(ts|tsx|js|mjs|cjs|json|jsonc|yml|yaml|toml|md|mdx|sh|go|py|rs|swift|css|scss|html)$/.test(
      rel,
    ) || ["Dockerfile", "Makefile", "README.md"].includes(path.basename(rel))
  );
}

function sourceSearch(rel: string, raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const chosen: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    if (
      i < 40 ||
      /^(#{1,4}\s|import\s|export\s|function\s|class\s|interface\s|type\s|const\s|let\s|describe\s*\(|it\s*\(|test\s*\(|name:\s|on:\s|jobs:\s)/.test(
        line,
      )
    ) {
      chosen.push(`${i + 1}: ${line}`);
    }
    if (chosen.join("\n").length >= maxSearchChars) break;
  }
  return compactSearch(`File: ${rel}\n${chosen.join("\n")}`);
}

function compactSearch(value: string): string {
  return clean(value).slice(0, maxSearchChars);
}

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function frontmatter(data: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === "") continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function stripFrontmatter(value: string): string {
  return value.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function firstHeading(value: string): string | undefined {
  return value
    .match(/^#\s+(.+)$/m)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .trim();
}

function titleize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function isLocaleDoc(rel: string): boolean {
  const first = rel.split("/")[0] ?? "";
  return (
    /^(zh-CN|zh-TW|ja-JP|pt-BR|[a-z]{2,3})$/.test(first ?? "") &&
    fs.existsSync(path.join(docsRepo, "docs", first, ".i18n", "README.md"))
  );
}

function sourceSha(): string {
  const metaPath = path.join(docsRepo, ".openclaw-sync", "source.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8")).sha;
  } catch {
    return gitDirExists(sourceRepo) ? git(sourceRepo, ["rev-parse", "HEAD"]) : "";
  }
}

function compareSourcePriority(a: string, b: string): number {
  return sourcePriority(a) - sourcePriority(b) || a.localeCompare(b);
}

function sourcePriority(rel: string): number {
  if (/^(src|extensions|packages)\//.test(rel)) return 0;
  if (/^(apps|ui|scripts|skills|config)\//.test(rel)) return 1;
  if (rel.startsWith(".github/")) return 2;
  if (/^(qa|security|test)\//.test(rel)) return 3;
  return rel.includes("/") ? 4 : 1;
}

function flatPath(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "__");
}

function languageForPath(value: string): string {
  return path.extname(value).replace(/^\./, "") || "text";
}

function rawUrlFor(repoUrl: string, sha: string, rel: string): string {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  return match
    ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${sha}/${encodeURI(rel)}`
    : "";
}

function labelsFromJson(value: unknown): string[] {
  return parseJsonArray(value)
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "name" in item) return String(item.name);
      return "";
    })
    .filter(Boolean)
    .slice(0, 12);
}

function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(typeof value === "string" && value ? value : "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function groupBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Map<unknown, T[]> {
  const map = new Map<unknown, T[]>();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key])?.push(row);
  }
  return map;
}

function sqlite<T extends SqlRow = SqlRow>(sqlText: string): T[] {
  const out = execFileSync("sqlite3", ["-json", gitcrawlDb, sqlText], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(out || "[]");
}

function sql(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function gitDirExists(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function safeStat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function sizeSummary(): string {
  const files = walk(outDir);
  let bytes = 0;
  for (const file of files) bytes += fs.statSync(file).size;
  return `${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
