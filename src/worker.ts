import { buildWorkspace, readWorkspace, searchWorkspace, workspaceContext } from "./retrieval";
import { systemPrompt } from "./prompt";
import type {
  Env,
  OpenAIChatResponse,
  OpenAIMessage,
  OpenAIStreamChunk,
  WorkspaceFile,
} from "./types";

const allowedOrigins = new Set([
  "https://documentation.openclaw.ai",
  "http://documentation.openclaw.ai",
  "https://docs.openclaw.ai",
  "http://docs.openclaw.ai",
  "https://openclaw.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);
const maxMessageLength = 2000;
const maxToolRounds = 4;
const maxShellOutput = 16_000;
const authCookieName = "ask_molty_session";
const authCookieMaxAgeSeconds = 60 * 60 * 24 * 7;
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
    if (pathname === "/ask-molty/auth/callback" && request.method === "POST")
      return authCallback(request, env);
    if (isChatPath(pathname) && ["GET", "HEAD"].includes(request.method))
      return sessionResponse(request, env);
    if (pathname === "/ask-molty/api/session" && ["GET", "HEAD"].includes(request.method))
      return sessionResponse(request, env);
    if (pathname === "/ask-molty/sign-in" && ["GET", "HEAD"].includes(request.method))
      return signInPage(request, env);
    if (!isChatPath(pathname) || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (!isAllowedChatOrigin(request)) return json(request, { error: "origin not allowed" }, 403);
    if (!(await hasValidSession(request, env)))
      return json(request, { authenticated: false, error: "GitHub verification required" }, 401);
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
      const messages = await messagesWithTools(env, message, workspace);
      const answer = await streamAnswer(env, messages);
      const headers = corsHeaders(request);
      headers.set("Content-Type", "text/plain; charset=utf-8");
      headers.set("Cache-Control", "no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("X-Workspace-File-Count", String(workspace.length));
      headers.set("X-Strategy", "workspace-tools-rag");
      return new Response(answer, { headers });
    } catch (error) {
      return json(request, { error: publicErrorMessage(error) }, 502);
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

async function messagesWithTools(
  env: Env,
  question: string,
  workspace: WorkspaceFile[],
): Promise<OpenAIMessage[]> {
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
    if (!assistant) return messages;
    const calls = assistant.tool_calls ?? [];
    if (!calls.length) return messages;
    messages.push(assistant);
    for (const call of calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(runTool(workspace, call.function.name, call.function.arguments)),
      });
    }
  }

  return messages;
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
    )
    .replace(
      /(^|[\s>])https:\/\/github\.com\/openclaw\/openclaw\/blob\/([0-9a-f]{7,40})\/([^\s)]+)/gi,
      (_match, prefix: string, sha: string, path: string) => {
        const cleanPath = trimTrailingPunctuation(path);
        const suffix = path.slice(cleanPath.length);
        const label = decodeURIComponent(cleanPath).replace(
          /#L(\d+)(?:-L(\d+))?$/,
          (_line, from, to) => (to ? `:L${from}-L${to}` : `:L${from}`),
        );
        return `${prefix}[${label}](https://github.com/openclaw/openclaw/blob/${sha}/${cleanPath})${suffix}`;
      },
    );
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;!?]+$/, "");
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

async function streamAnswer(
  env: Env,
  messages: OpenAIMessage[],
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: openAIHeaders(env),
    body: JSON.stringify({ ...openAIBody(env, messages, false), stream: true }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.body) throw new Error("OpenAI stream missing response body");
  return response.body.pipeThrough(openAITextStream());
}

function openAITextStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  let textBuffer = "";

  const flushText = (controller: TransformStreamDefaultController<Uint8Array>, force = false) => {
    const flushLength = force ? textBuffer.length : safeFlushLength(textBuffer);
    if (!flushLength) return;
    controller.enqueue(encoder.encode(compactGithubLinks(textBuffer.slice(0, flushLength))));
    textBuffer = textBuffer.slice(flushLength);
  };

  const processEvent = (
    event: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data) as OpenAIStreamChunk;
      const content = parsed.choices?.[0]?.delta?.content;
      if (!content) continue;
      textBuffer += content;
      flushText(controller);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const events = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = events.pop() ?? "";
      for (const event of events) processEvent(event, controller);
    },
    flush(controller) {
      const rest = decoder.decode();
      if (rest) sseBuffer += rest;
      if (sseBuffer.trim()) processEvent(sseBuffer, controller);
      flushText(controller, true);
    },
  });
}

function safeFlushLength(text: string): number {
  const prefix = "https://github.com/openclaw/openclaw/";
  const markdownTargetStart = text.lastIndexOf("](");
  if (markdownTargetStart >= 0) {
    const markdownTarget = text.slice(markdownTargetStart + 2);
    if (
      !markdownTarget.includes(")") &&
      (!markdownTarget || prefix.startsWith(markdownTarget) || markdownTarget.startsWith(prefix))
    )
      return markdownTargetStart;
  }

  const rawUrlStart = text.lastIndexOf("https://github.com/openclaw/openclaw/");
  if (rawUrlStart >= 0 && !/[\s)]/.test(text.slice(rawUrlStart))) return rawUrlStart;

  for (let length = Math.min(prefix.length - 1, text.length); length > 0; length -= 1)
    if (prefix.startsWith(text.slice(-length))) return text.length - length;

  return text.length;
}

async function openAI(
  env: Env,
  messages: OpenAIMessage[],
  withTools: boolean,
): Promise<OpenAIChatResponse> {
  const body = openAIBody(env, messages, withTools);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: openAIHeaders(env),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json<OpenAIChatResponse>();
}

function openAIBody(
  env: Env,
  messages: OpenAIMessage[],
  withTools: boolean,
): Record<string, unknown> {
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
  return body;
}

function openAIHeaders(env: Env): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
  };
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") ?? "";
  if (allowedOrigins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Expose-Headers", "X-Workspace-File-Count, X-Strategy");
  headers.set("Vary", "Origin");
  return headers;
}

function isAllowedChatOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return Boolean(origin && allowedOrigins.has(origin));
}

function isChatPath(pathname: string): boolean {
  return pathname === "/api/chat" || pathname === "/ask-molty/api/chat";
}

function json(request: Request, data: unknown, status = 200): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

type VerifiedClawHubSession =
  | {
      ok: true;
      provider: "github";
      user: { id: string; handle: string | null };
    }
  | { ok: false };

async function verifyClawHubSession(
  env: Env,
  token: string,
  registry: string | null,
): Promise<VerifiedClawHubSession> {
  const verifyUrl = new URL(
    env.CLAWHUB_SESSION_VERIFY_URL ?? "https://clawhub.ai/api/v1/docs/session/verify",
  );
  if (registry && isAllowedClawHubRegistry(registry)) {
    verifyUrl.protocol = new URL(registry).protocol;
    verifyUrl.host = new URL(registry).host;
  }
  const response = await fetch(verifyUrl.href, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return { ok: false };
  const body = (await response.json()) as {
    provider?: unknown;
    user?: { id?: unknown; handle?: unknown };
  };
  const id = typeof body.user?.id === "string" ? body.user.id : "";
  if (!id || body.provider !== "github") return { ok: false };
  return {
    ok: true,
    provider: "github",
    user: {
      id,
      handle: typeof body.user?.handle === "string" ? body.user.handle : null,
    },
  };
}

function isAllowedClawHubRegistry(value: string) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://clawhub.ai" ||
      url.origin === "https://hub.openclaw.ai" ||
      url.origin === "http://localhost:3000" ||
      url.origin === "http://127.0.0.1:3000"
    );
  } catch {
    return false;
  }
}

type SessionPayload = {
  provider: "github";
  sub: string;
  exp: number;
};

async function hasValidSession(request: Request, env: Env) {
  const cookie = parseCookies(request.headers.get("Cookie")).get(authCookieName);
  if (!cookie) return false;
  const payload = await verifySessionCookie(env, cookie, request);
  return Boolean(payload && payload.exp > Math.floor(Date.now() / 1000));
}

async function createSessionCookie(env: Env, payload: SessionPayload, request: Request) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await signValue(env, encodedPayload, request);
  return `${encodedPayload}.${signature}`;
}

async function verifySessionCookie(
  env: Env,
  cookie: string,
  request: Request,
): Promise<SessionPayload | null> {
  const [payload, signature, extra] = cookie.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await signValue(env, payload, request);
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<SessionPayload>;
    if (parsed.provider !== "github" || !parsed.sub || typeof parsed.exp !== "number") return null;
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

async function signValue(env: Env, value: string, request: Request) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret(env, request)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function authSecret(env: Env, request: Request) {
  if (env.ASK_MOLTY_AUTH_SECRET) return env.ASK_MOLTY_AUTH_SECRET;
  if (isLocalRequest(request)) return env.OPENAI_API_KEY || "ask-molty-local-dev";
  throw new Error("ASK_MOLTY_AUTH_SECRET missing");
}

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function publicErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Ask Molty failed";
  const openAiStatus = error.message.match(/^OpenAI error (\d+)/)?.[1];
  if (openAiStatus) return `OpenAI error ${openAiStatus}`;
  return error.message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies.set(key, value);
  }
  return cookies;
}

function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sessionResponse(request: Request, env: Env): Promise<Response> {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  const authenticated = await hasValidSession(request, env);
  const status = authenticated ? 200 : 401;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(
    JSON.stringify({ authenticated, provider: authenticated ? "github" : null }),
    {
      status,
      headers,
    },
  );
}

function signInPage(request: Request, env: Env): Response {
  const returnTo = safeDocsReturnTo(request) ?? new URL("/", request.url).href;
  const authUrl = new URL(env.CLAWHUB_AUTH_URL ?? "https://hub.openclaw.ai/docs/auth");
  authUrl.searchParams.set("return_to", returnTo);
  return Response.redirect(authUrl.href, 302);
}

async function authCallback(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return authErrorPage("Invalid verification response.", 400);
  }

  const token = stringFormValue(form.get("token"));
  const returnTo = normalizeDocsReturnTo(stringFormValue(form.get("return_to")));
  const registry = stringFormValue(form.get("registry"));
  if (!token || !returnTo) return authErrorPage("Invalid verification response.", 400);

  const verified = await verifyClawHubSession(env, token, registry);
  if (!verified.ok) return authErrorPage("GitHub verification failed.", 401);

  const cookie = await createSessionCookie(
    env,
    {
      provider: verified.provider,
      sub: verified.user.handle ?? verified.user.id,
      exp: Math.floor(Date.now() / 1000) + authCookieMaxAgeSeconds,
    },
    request,
  );
  const headers = new Headers({
    Location: returnTo,
    "Cache-Control": "no-store",
    "Set-Cookie": `${authCookieName}=${cookie}; Max-Age=${authCookieMaxAgeSeconds}; Path=/ask-molty; HttpOnly; Secure; SameSite=Lax`,
  });
  return new Response(null, { status: 302, headers });
}

function authErrorPage(message: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Ask Molty verification failed</title><style>html{color-scheme:dark;background:#0b0a0a;color:#f4eeee;font:16px system-ui,sans-serif}main{max-width:520px;margin:16vh auto;padding:0 24px}a{color:#ff875f}</style><main><h1>Verification failed</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to docs</a></p></main>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function safeDocsReturnTo(request: Request): string | null {
  const url = new URL(request.url);
  const value = url.searchParams.get("return_to");
  return normalizeDocsReturnTo(value);
}

function normalizeDocsReturnTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    if (!allowedOrigins.has(target.origin)) return null;
    if (!["http:", "https:"].includes(target.protocol)) return null;
    return target.href;
  } catch {
    return null;
  }
}

function stringFormValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
