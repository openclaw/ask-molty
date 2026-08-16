#!/usr/bin/env node
/// <reference types="@cloudflare/workers-types" />

import fs from "node:fs";
import path from "node:path";
import { normalizeDocsReturnTo } from "../src/auth";
import { buildWorkspace } from "../src/retrieval";
import type { Env } from "../src/types";
import { openAI, streamAnswer } from "../src/worker";

const root = process.cwd();
const outDir = path.join(root, "dist", "test");
const required = [
  "docs-search.jsonl",
  "source-search.jsonl",
  "github-search.jsonl",
  "workspace-manifest.json",
];

smokeAuthRouting();
await smokeOpenAIFetchTimeout();
await smokeRuntimeRetrieval();

if (process.env.ASK_MOLTY_SKIP_EXPORT_SMOKE === "1") {
  console.log("ask-molty smoke ok: runtime checks only");
} else {
  for (const rel of required) {
    const file = path.join(outDir, rel);
    if (!fs.existsSync(file)) throw new Error(`missing ${rel}`);
    if (fs.statSync(file).size < 10) throw new Error(`empty ${rel}`);
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(outDir, "workspace-manifest.json"), "utf8"),
  );
  const fileCount = Object.keys(manifest.files ?? {}).length;
  if (fileCount < 1000) throw new Error(`workspace too small: ${fileCount} files`);

  const source = fs.readFileSync(path.join(outDir, "source-search.jsonl"), "utf8");
  if (!source.includes("model-selection"))
    throw new Error("source index did not include model-selection");

  const github = fs.readFileSync(path.join(outDir, "github-search.jsonl"), "utf8");
  if (!github.includes("github.com/openclaw/openclaw"))
    throw new Error("github index missing OpenClaw links");

  console.log(`ask-molty smoke ok: ${fileCount} workspace files`);
}

function smokeAuthRouting(): void {
  const canonical = normalizeDocsReturnTo("https://docs.clawhub.ai/plugins");
  if (canonical !== "https://docs.clawhub.ai/plugins") {
    throw new Error(`auth routing: canonical docs return changed to ${canonical}`);
  }

  const legacy = normalizeDocsReturnTo("https://hub.openclaw.ai/docs/plugins?tab=publish");
  if (legacy !== "https://docs.clawhub.ai/plugins?tab=publish") {
    throw new Error(`auth routing: legacy docs return did not canonicalize: ${legacy}`);
  }

  const docsSite = normalizeDocsReturnTo("https://docs.openclaw.ai/install");
  if (docsSite !== "https://docs.openclaw.ai/install") {
    throw new Error(`auth routing: docs site return changed to ${docsSite}`);
  }

  if (normalizeDocsReturnTo("https://example.com/docs") !== null) {
    throw new Error("auth routing: unrelated docs origin was accepted");
  }

  console.log("auth routing ok: ClawHub docs origins accepted and canonicalized");
}

async function smokeRuntimeRetrieval(): Promise<void> {
  const docsIndexUrl = "https://example.test/docs-search.json";
  const docsCorpusUrl = "https://example.test/llms-full.txt";
  const sourceIndexUrl = "https://example.test/source-index.jsonl";
  const githubIndexUrl = "https://example.test/github-search.jsonl";
  const emptyIndex = " ".repeat(1000);
  const env: Env = {
    OPENAI_API_KEY: "test",
    DOCS_INDEX_URL: docsIndexUrl,
    DOCS_CORPUS_URL: docsCorpusUrl,
    SOURCE_INDEX_URL: sourceIndexUrl,
    GITHUB_INDEX_URL: githubIndexUrl,
  };

  const docsIndex = JSON.stringify({
    version: 1,
    entries: [
      {
        title: "Getting started",
        url: "/start/getting-started",
        snippet: "Install and configure OpenClaw.",
        search: "getting started install configure ".repeat(80),
      },
    ],
  });

  const sourceIndex = `${JSON.stringify({
    path: "src/settings.ts",
    search: "settings implementation issue ".repeat(80),
  })}\n`;
  const githubIndex = `${JSON.stringify({
    path: "/workspace/github/000.md#issue-123",
    number: 123,
    state: "open",
    title: "Settings issue",
    url: "https://github.com/openclaw/openclaw/issues/123",
    search: "settings implementation issue ".repeat(80),
  })}\n`;
  const docsCorpus = [
    "# Deep fallback page",
    "Source: https://docs.openclaw.ai/deep/fallback",
    "",
    "obscure fallback phrase ".repeat(80),
  ].join("\n");

  const firstCalls: string[] = [];
  const storedCalls: string[] = [];
  await withMockNetwork(
    async (url) => {
      storedCalls.push(url);
      if (url === githubIndexUrl) return new Response(githubIndex);
      return new Response("missing", { status: 522 });
    },
    async () => {
      const files = await buildWorkspace(
        {
          ...env,
          DOCS_ARTIFACTS: fakeR2({
            "docs-search.json": docsIndex,
            "source-index.jsonl": sourceIndex,
          }),
        },
        "getting started settings implementation issue",
      );
      if (!files.some((file) => file.path === "/docs/start__getting-started.md")) {
        throw new Error("runtime retrieval: R2 docs index was not mounted");
      }
      if (!files.some((file) => file.kind === "source")) {
        throw new Error("runtime retrieval: R2 source index was not mounted");
      }
    },
  );
  if (storedCalls.includes(docsIndexUrl) || storedCalls.includes(sourceIndexUrl)) {
    throw new Error("runtime retrieval: public docs host used despite usable R2 artifacts");
  }
  console.log("runtime retrieval ok: R2 survives public docs host outage");

  await withMockNetwork(
    async (url) => {
      firstCalls.push(url);
      if (url === docsIndexUrl) return new Response(docsIndex);
      if (url === sourceIndexUrl || url === githubIndexUrl) return new Response(emptyIndex);
      return new Response("missing", { status: 404 });
    },
    async () => {
      const files = await buildWorkspace(env, "getting started");
      if (
        !files.some(
          (file) =>
            file.path === "/docs/start__getting-started.md" &&
            file.url === "https://example.test/start/getting-started",
        )
      ) {
        throw new Error("runtime retrieval: docs-search.json record was not mounted");
      }
    },
  );
  if (firstCalls.includes(docsCorpusUrl)) {
    throw new Error("runtime retrieval: docs corpus loaded despite a usable docs index");
  }
  console.log("runtime retrieval ok: docs-search.json mounted without corpus fetch");

  await withMockNetwork(
    async (url) => {
      if (url === docsIndexUrl) return new Response("missing", { status: 503 });
      if (url === docsCorpusUrl) return new Response(docsCorpus);
      if (url === sourceIndexUrl || url === githubIndexUrl) return new Response(emptyIndex);
      return new Response("missing", { status: 404 });
    },
    async () => {
      const files = await buildWorkspace(env, "obscure fallback phrase");
      if (!files.some((file) => file.url === "https://docs.openclaw.ai/deep/fallback")) {
        throw new Error("runtime retrieval: docs corpus fallback was not mounted");
      }
    },
  );
  console.log("runtime retrieval ok: docs corpus fallback mounted after index failure");

  await withMockNetwork(
    async (url) => {
      if (url === sourceIndexUrl) return new Response(sourceIndex);
      if (url === githubIndexUrl) return new Response(githubIndex);
      return new Response("missing", { status: 522 });
    },
    async () => {
      const files = await buildWorkspace(env, "settings implementation issue");
      if (!files.some((file) => file.path === "/workspace/docs/unavailable.md")) {
        throw new Error("runtime retrieval: missing docs unavailable workspace note");
      }
      if (!files.some((file) => file.kind === "source")) {
        throw new Error("runtime retrieval: source context was blocked by docs outage");
      }
      if (!files.some((file) => file.kind === "github")) {
        throw new Error("runtime retrieval: GitHub context was blocked by docs outage");
      }
    },
  );
  console.log("runtime retrieval ok: docs outage keeps source and GitHub context");
}

async function smokeOpenAIFetchTimeout(): Promise<void> {
  const env: Env = { OPENAI_API_KEY: "test" };
  const messages = [{ role: "user" as const, content: "ping" }];
  const signals: Array<AbortSignal | undefined> = [];

  await withMockNetwork(
    async (url, init) => {
      if (!url.includes("api.openai.com/v1/chat/completions")) {
        return new Response("missing", { status: 404 });
      }
      signals.push(init?.signal ?? undefined);
      if (init?.body && String(init.body).includes('"stream":true')) {
        return new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    },
    async () => {
      await openAI(env, messages, false);
      const stream = await streamAnswer(env, messages);
      await stream.pipeTo(new WritableStream());
    },
  );

  if (signals.length !== 2) {
    throw new Error(`OpenAI fetch timeout: expected 2 chat fetches, got ${signals.length}`);
  }
  for (const [index, signal] of signals.entries()) {
    if (!(signal instanceof AbortSignal)) {
      throw new Error(`OpenAI fetch timeout: fetch ${index + 1} has no AbortSignal`);
    }
  }
  console.log("openai fetch timeout ok: chat and tool fetches pass AbortSignal");

  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (ms: number) => originalTimeout(Math.min(ms, 20));
  try {
    await withMockNetwork(
      async (url, init) => {
        if (!url.includes("api.openai.com/v1/chat/completions")) {
          return new Response("missing", { status: 404 });
        }
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const fail = () => {
            const error = new Error("The operation was aborted due to timeout");
            error.name = "TimeoutError";
            reject(error);
          };
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        });
      },
      async () => {
        const started = Date.now();
        let timedOut = false;
        try {
          await Promise.race([
            openAI(env, messages, true),
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("OpenAI fetch watchdog: request did not abort")),
                1000,
              );
            }),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("watchdog")) throw error;
          timedOut = true;
        }
        if (!timedOut) throw new Error("OpenAI tool fetch hung instead of aborting");
        if (Date.now() - started > 500) {
          throw new Error("OpenAI tool fetch abort took too long");
        }

        timedOut = false;
        try {
          await Promise.race([
            streamAnswer(env, messages),
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("OpenAI stream watchdog: request did not abort")),
                1000,
              );
            }),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("watchdog")) throw error;
          timedOut = true;
        }
        if (!timedOut) throw new Error("OpenAI stream fetch hung instead of aborting");
      },
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  console.log("openai fetch timeout ok: hung chat and tool fetches abort");
}

function fakeR2(objects: Record<string, string>): R2Bucket {
  return {
    get: async (key: string) => {
      const value = objects[key];
      return value === undefined
        ? null
        : {
            body: new Response(value).body,
            size: new TextEncoder().encode(value).byteLength,
            text: async () => value,
          };
    },
  } as unknown as R2Bucket;
}

async function withMockNetwork(
  fetchText: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as unknown as { caches?: CacheStorage }).caches;
  const cache = new Map<string, string>();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetchText(url, init);
    },
  });
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => {
          const text = cache.get(request.url);
          return text === undefined ? undefined : new Response(text);
        },
        put: async (request: Request, response: Response) => {
          cache.set(request.url, await response.clone().text());
        },
      },
    },
  });
  try {
    await run();
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: originalCaches,
    });
  }
}
