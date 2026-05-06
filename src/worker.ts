import { buildWorkspace, readWorkspace, searchWorkspace, workspaceContext } from "./retrieval";
import { systemPrompt } from "./prompt";
import type { Env, OpenAIChatResponse, OpenAIMessage, WorkspaceFile } from "./types";

const allowedOrigins = new Set([
  "https://documentation.openclaw.ai",
  "http://documentation.openclaw.ai",
  "https://openclaw.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);
const maxMessageLength = 2000;
const maxToolRounds = 4;
const maxShellOutput = 16_000;
const artifactUrls: Record<string, string> = {
  "/ask-molty/github-search.jsonl":
    "https://github.com/openclaw/ask-molty/releases/download/workspace-latest/github-search.jsonl",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    const pathname = new URL(request.url).pathname;
    if (pathname in artifactUrls) return serveArtifact(request, artifactUrls[pathname] ?? "");
    if (pathname !== "/api/chat" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (!env.OPENAI_API_KEY) return json(request, { error: "OPENAI_API_KEY missing" }, 500);

    let message = "";
    try {
      const body = await request.json<{ message?: unknown }>();
      message = typeof body.message === "string" ? body.message.trim() : "";
    } catch {
      return json(request, { error: "Invalid JSON" }, 400);
    }
    if (!message) return json(request, { error: "message required" }, 400);
    if (message.length > maxMessageLength) return json(request, { error: "message too long" }, 400);

    try {
      const workspace = await buildWorkspace(env, message);
      const answer = compactGithubLinks(await answerWithTools(env, message, workspace));
      const headers = corsHeaders(request);
      headers.set("Content-Type", "text/plain; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set("X-Workspace-File-Count", String(workspace.length));
      headers.set("X-Strategy", "workspace-tools-rag");
      return new Response(answer, { headers });
    } catch (error) {
      return json(
        request,
        { error: error instanceof Error ? error.message : "Ask Molty failed" },
        502,
      );
    }
  },
};

async function serveArtifact(request: Request, url: string): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", { status: 405 });
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return request.method === "HEAD" ? new Response(null, cached) : cached;

  const upstream = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 3600 } });
  if (!upstream.ok)
    return new Response(`Artifact unavailable: ${upstream.status}`, { status: 502 });
  const headers = new Headers(upstream.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=300, s-maxage=3600");
  headers.set("Content-Type", "application/x-ndjson; charset=utf-8");
  headers.delete("Content-Disposition");
  const response = new Response(upstream.body, { headers, status: upstream.status });
  await cache.put(cacheKey, response.clone());
  return request.method === "HEAD" ? new Response(null, response) : response;
}

async function answerWithTools(
  env: Env,
  question: string,
  workspace: WorkspaceFile[],
): Promise<string> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Question: ${question}

Mounted read-only workspace:
${workspaceContext(workspace)}

Use workspace tools if you need to search or read exact files before answering.`,
    },
  ];

  for (let round = 0; round < maxToolRounds; round += 1) {
    const response = await openAI(env, messages, true);
    const assistant = response.choices?.[0]?.message;
    if (!assistant) return "No answer returned.";
    messages.push(assistant);
    const calls = assistant.tool_calls ?? [];
    if (!calls.length) return assistant.content?.trim() || "No answer returned.";
    for (const call of calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(runTool(workspace, call.function.name, call.function.arguments)),
      });
    }
  }

  const finalResponse = await openAI(env, messages, false);
  return finalResponse.choices?.[0]?.message?.content?.trim() || "No answer returned.";
}

function runTool(workspace: WorkspaceFile[], name: string, rawArgs: string): unknown {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { error: "invalid JSON arguments" };
  }
  if (name === "search_workspace") {
    const query = typeof args.query === "string" ? args.query : "";
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    const limit = typeof args.limit === "number" ? args.limit : 8;
    return { results: searchWorkspace(workspace, query, kind, limit) };
  }
  if (name === "read_workspace") {
    const path = typeof args.path === "string" ? args.path : "";
    const file = readWorkspace(workspace, path);
    if (!file) return { error: `file not mounted: ${path}` };
    return {
      path: displayToolPath(file),
      kind: file.kind,
      url: file.url,
      content: file.content.slice(0, 12_000),
    };
  }
  if (name === "list_workspace") {
    const prefix = typeof args.prefix === "string" ? args.prefix.replace(/^\/+/, "") : "";
    return {
      files: workspace
        .filter((file) => !prefix || file.path.replace(/^\/+/, "").startsWith(prefix))
        .map((file) => ({ path: displayToolPath(file), kind: file.kind, url: file.url })),
    };
  }
  if (name === "run_shell") {
    const command = typeof args.command === "string" ? args.command : "";
    return runReadOnlyShell(workspace, command);
  }
  return { error: `unknown tool: ${name}` };
}

function displayToolPath(file: WorkspaceFile): string {
  return file.kind === "github" && file.url ? file.url : file.path;
}

function compactGithubLinks(text: string): string {
  return text
    .replace(
      /(^|[\s>])https:\/\/github\.com\/openclaw\/openclaw\/issues\/(\d+)\/?(?=[\s).,;!?]|$)/g,
      (_match, prefix: string, number: string) =>
        `${prefix}[Issue #${number}](https://github.com/openclaw/openclaw/issues/${number})`,
    )
    .replace(
      /(^|[\s>])https:\/\/github\.com\/openclaw\/openclaw\/pull\/(\d+)\/?(?=[\s).,;!?]|$)/g,
      (_match, prefix: string, number: string) =>
        `${prefix}[PR #${number}](https://github.com/openclaw/openclaw/pull/${number})`,
    )
    .replace(
      /(^|[\s>])https:\/\/github\.com\/openclaw\/openclaw\/commit\/([0-9a-f]{7,40})\/?(?=[\s).,;!?]|$)/gi,
      (_match, prefix: string, sha: string) =>
        `${prefix}[commit ${sha.slice(0, 7)}](https://github.com/openclaw/openclaw/commit/${sha})`,
    );
}

function runReadOnlyShell(
  workspace: WorkspaceFile[],
  command: string,
): { command: string; output: string } | { error: string } {
  const argv = parseShell(command);
  const executable = argv[0];
  if (!executable) return { error: "command required" };
  if (["rg", "grep"].includes(executable)) return runRg(workspace, command, argv);
  if (executable === "cat") return runCat(workspace, command, argv);
  if (executable === "head") return runHead(workspace, command, argv);
  if (executable === "ls" || executable === "find") return runFind(workspace, command, argv);
  return {
    error:
      "unsupported readonly command. Supported: rg, grep, cat, head, ls, find. Pipes, redirects, writes, and network commands are disabled.",
  };
}

function runRg(
  workspace: WorkspaceFile[],
  command: string,
  argv: string[],
): { command: string; output: string } | { error: string } {
  const args = argv.slice(1).filter((arg) => !arg.startsWith("-"));
  const query = args[0] ?? "";
  const prefix = normalizeShellPath(args[1] ?? "");
  if (!query) return { error: "usage: rg <query> [path-prefix]" };
  const needle = query.toLowerCase();
  const lines: string[] = [];
  for (const file of workspace) {
    const normalized = normalizeShellPath(file.path);
    if (prefix && !normalized.startsWith(prefix)) continue;
    const contentLines = file.content.split("\n");
    for (let index = 0; index < contentLines.length; index += 1) {
      const line = contentLines[index] ?? "";
      if (!line.toLowerCase().includes(needle)) continue;
      lines.push(`${file.path}:${index + 1}:${line.slice(0, 500)}`);
      if (lines.length >= 120) return { command, output: truncateShell(lines.join("\n")) };
    }
  }
  return { command, output: lines.length ? truncateShell(lines.join("\n")) : "no matches" };
}

function runCat(
  workspace: WorkspaceFile[],
  command: string,
  argv: string[],
): { command: string; output: string } | { error: string } {
  const file = readWorkspace(workspace, argv[1] ?? "");
  if (!file) return { error: `file not mounted: ${argv[1] ?? ""}` };
  return { command, output: truncateShell(file.content) };
}

function runHead(
  workspace: WorkspaceFile[],
  command: string,
  argv: string[],
): { command: string; output: string } | { error: string } {
  let count = 80;
  let target = argv[1] ?? "";
  if (argv[1] === "-n") {
    count = Math.max(1, Math.min(Number(argv[2] ?? 80), 300));
    target = argv[3] ?? "";
  }
  const file = readWorkspace(workspace, target);
  if (!file) return { error: `file not mounted: ${target}` };
  return { command, output: truncateShell(file.content.split("\n").slice(0, count).join("\n")) };
}

function runFind(
  workspace: WorkspaceFile[],
  command: string,
  argv: string[],
): { command: string; output: string } {
  const prefix = normalizeShellPath(argv[1] ?? "");
  const files = workspace
    .map((file) => file.path)
    .filter((file) => !prefix || normalizeShellPath(file).startsWith(prefix))
    .sort();
  return { command, output: files.join("\n") || "no files" };
}

function parseShell(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern))
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

function normalizeShellPath(value: string): string {
  return value
    .replace(/^\.?\//, "")
    .replace(/^workspace\/?/, "")
    .replace(/\/+/g, "/");
}

function truncateShell(value: string): string {
  return value.length > maxShellOutput
    ? `${value.slice(0, maxShellOutput)}\n... truncated ...`
    : value;
}

async function openAI(
  env: Env,
  messages: OpenAIMessage[],
  withTools: boolean,
): Promise<OpenAIChatResponse> {
  const body: Record<string, unknown> = {
    model: env.OPENAI_MODEL ?? "chat-latest",
    messages,
  };
  if (withTools) {
    body.tools = [
      {
        type: "function",
        function: {
          name: "search_workspace",
          description: "Search the mounted read-only OpenClaw docs/source/GitHub workspace.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              kind: { type: "string", enum: ["docs", "source", "github"] },
              limit: { type: "number" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_workspace",
          description: "Read one mounted workspace file by path.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_workspace",
          description: "List mounted workspace files, optionally under a path prefix.",
          parameters: {
            type: "object",
            properties: {
              prefix: { type: "string" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_shell",
          description:
            "Run a readonly fake shell against mounted workspace files. Supports rg, grep, cat, head, ls, and find only.",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description:
                  "Readonly command, for example: rg model-selection /workspace/source or cat /workspace/docs/install.md",
              },
            },
            required: ["command"],
          },
        },
      },
    ];
    body.tool_choice = "auto";
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json<OpenAIChatResponse>();
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") ?? "";
  if (allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Expose-Headers", "X-Workspace-File-Count, X-Strategy");
  headers.set("Vary", "Origin");
  return headers;
}

function json(request: Request, data: unknown, status = 200): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}
