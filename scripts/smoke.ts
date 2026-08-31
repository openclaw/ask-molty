#!/usr/bin/env node
/// <reference types="@cloudflare/workers-types" />

import fs from "node:fs";
import path from "node:path";
import { normalizeDocsReturnTo } from "../src/auth";
import {
  buildWorkspace,
  maxJsonlStreamBytes,
  maxSourceRawBytes,
  maxSourceRawChars,
  maxWorkspaceTextBytes,
  retrievalTimeouts,
} from "../src/retrieval";
import type { Env } from "../src/types";
import { openAI, openAITimeouts, streamAnswer } from "../src/worker";

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
await smokeMalformedOpenAISse();
await smokeRuntimeRetrieval();
await smokeRetrievalFetchTimeout();
await smokeRetrievalBodyCaps();

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

async function smokeRetrievalFetchTimeout(): Promise<void> {
  const docsIndexUrl = "https://example.test/docs-search.json";
  const docsCorpusUrl = "https://example.test/llms-full.txt";
  const sourceIndexUrl = "https://example.test/source-index.jsonl";
  const githubIndexUrl = "https://example.test/github-search.jsonl";
  const rawUrl = "https://example.test/raw/settings.ts";
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
        title: "Settings",
        url: "/settings",
        snippet: "Settings implementation.",
        search: "settings implementation issue ".repeat(80),
      },
    ],
  });
  const sourceIndex = `${JSON.stringify({
    path: "src/settings.ts",
    search: "settings implementation issue ".repeat(80),
    rawUrl,
    url: "https://github.com/openclaw/openclaw/blob/main/src/settings.ts",
  })}\n`;
  const githubIndex = `${JSON.stringify({
    path: "/workspace/github/000.md#issue-123",
    number: 123,
    state: "open",
    title: "Settings issue",
    url: "https://github.com/openclaw/openclaw/issues/123",
    search: "settings implementation issue ".repeat(80),
  })}\n`;
  const signals = new Map<string, AbortSignal | undefined>();

  await withMockNetwork(
    async (url, init) => {
      signals.set(url, init?.signal ?? undefined);
      if (url === docsIndexUrl) return new Response(docsIndex);
      if (url === sourceIndexUrl) return new Response(sourceIndex);
      if (url === githubIndexUrl) return new Response(githubIndex);
      if (url === rawUrl) return new Response("export const settings = 1;\n");
      return new Response("missing", { status: 404 });
    },
    async () => {
      await buildWorkspace(env, "settings implementation issue");
    },
  );

  for (const url of [docsIndexUrl, sourceIndexUrl, githubIndexUrl, rawUrl]) {
    if (!(signals.get(url) instanceof AbortSignal)) {
      throw new Error(`retrieval fetch timeout: ${url} has no AbortSignal`);
    }
  }
  if (signals.has(docsCorpusUrl)) {
    throw new Error("retrieval fetch timeout: docs corpus fetched despite a usable index");
  }
  console.log("retrieval fetch timeout ok: corpus, index, and rawUrl fetches pass AbortSignal");

  const previousHeaderMs = retrievalTimeouts.headerMs;
  retrievalTimeouts.headerMs = 20;
  try {
    await withMockNetwork(
      async (_url, init) => hangUntilAborted(init),
      async () => {
        const started = Date.now();
        const files = await Promise.race([
          buildWorkspace(env, "settings implementation issue"),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("retrieval fetch watchdog: request did not abort")),
              1000,
            );
          }),
        ]);
        if (Date.now() - started > 500) {
          throw new Error("retrieval fetch abort took too long");
        }
        if (!files.some((file) => file.path === "/workspace/docs/unavailable.md")) {
          throw new Error("retrieval fetch timeout: hung indexes did not fail closed");
        }
        if (files.some((file) => file.kind === "source" || file.kind === "github")) {
          throw new Error("retrieval fetch timeout: hung indexes still mounted source or GitHub");
        }
      },
    );
  } finally {
    retrievalTimeouts.headerMs = previousHeaderMs;
  }
  console.log("retrieval fetch timeout ok: hung corpus and index fetches abort");

  retrievalTimeouts.headerMs = 20;
  try {
    let rawHung = false;
    await withMockNetwork(
      async (url, init) => {
        if (url === docsIndexUrl) return new Response(docsIndex);
        if (url === sourceIndexUrl) return new Response(sourceIndex);
        if (url === githubIndexUrl) return new Response(githubIndex);
        if (url === rawUrl) {
          rawHung = true;
          return hangUntilAborted(init);
        }
        return new Response("missing", { status: 404 });
      },
      async () => {
        const started = Date.now();
        const files = await Promise.race([
          buildWorkspace(env, "settings implementation issue"),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("retrieval rawUrl watchdog: request did not abort")),
              1000,
            );
          }),
        ]);
        if (!rawHung) throw new Error("retrieval fetch timeout: source rawUrl was not fetched");
        if (Date.now() - started > 500) {
          throw new Error("retrieval rawUrl fetch abort took too long");
        }
        if (!files.some((file) => file.kind === "source")) {
          throw new Error("retrieval fetch timeout: hung rawUrl blocked source context");
        }
      },
    );
  } finally {
    retrievalTimeouts.headerMs = previousHeaderMs;
  }
  console.log(
    "retrieval fetch timeout ok: hung source rawUrl fetch aborts without blocking the mount",
  );
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
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

  const previousHeaderMs = openAITimeouts.headerMs;
  const previousIdleMs = openAITimeouts.bodyIdleMs;
  openAITimeouts.headerMs = 20;
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
    openAITimeouts.headerMs = previousHeaderMs;
  }
  console.log("openai fetch timeout ok: hung chat and tool fetches abort");

  openAITimeouts.headerMs = 30;
  openAITimeouts.bodyIdleMs = 80;
  try {
    let toolBodyCancelled = false;
    await withMockNetwork(
      async (url) => {
        if (!url.includes("api.openai.com/v1/chat/completions")) {
          return new Response("missing", { status: 404 });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"choices":['));
            },
            cancel() {
              toolBodyCancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      async () => {
        let idleTimedOut = false;
        try {
          await openAI(env, messages, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("idle timed out")) throw error;
          idleTimedOut = true;
        }
        if (!idleTimedOut) throw new Error("OpenAI tool response body idle timeout did not fire");
      },
    );
    if (!toolBodyCancelled) throw new Error("OpenAI timed-out tool response was not cancelled");

    await withMockNetwork(
      async (url) => {
        if (!url.includes("api.openai.com/v1/chat/completions")) {
          return new Response("missing", { status: 404 });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
      async () => {
        const stream = await streamAnswer(env, messages);
        await new Promise((resolve) => setTimeout(resolve, 50));
        let idleTimedOut = false;
        try {
          await stream.pipeTo(new WritableStream());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("idle timed out")) throw error;
          idleTimedOut = true;
        }
        if (!idleTimedOut) throw new Error("OpenAI stream idle timeout did not fire");
      },
    );

    openAITimeouts.headerMs = 40;
    openAITimeouts.bodyIdleMs = 200;
    await withMockNetwork(
      async (url) => {
        if (!url.includes("api.openai.com/v1/chat/completions")) {
          return new Response("missing", { status: 404 });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
              );
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }, 80);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
      async () => {
        const started = Date.now();
        const stream = await streamAnswer(env, messages);
        await stream.pipeTo(new WritableStream());
        if (Date.now() - started < 60) {
          throw new Error("healthy stream finished before the delayed chunk");
        }
      },
    );
  } finally {
    openAITimeouts.headerMs = previousHeaderMs;
    openAITimeouts.bodyIdleMs = previousIdleMs;
  }
  console.log(
    "openai fetch timeout ok: response bodies are idle-bounded without cutting a healthy stream",
  );
}

async function smokeMalformedOpenAISse(): Promise<void> {
  const env: Env = { OPENAI_API_KEY: "test" };
  const messages = [{ role: "user" as const, content: "ping" }];
  const encoder = new TextEncoder();

  await withMockNetwork(
    async (url) => {
      if (!url.includes("api.openai.com/v1/chat/completions")) {
        return new Response("missing", { status: 404 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
            );
            controller.enqueue(encoder.encode("data: {not-valid-json\n\n"));
            for (const payload of [
              null,
              false,
              42,
              "not a chunk",
              { choices: [{ delta: { content: { text: "not text" } } }] },
            ]) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    async () => {
      const stream = await streamAnswer(env, messages);
      let text = "";
      try {
        text = await new Response(stream).text();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`OpenAI SSE: malformed JSON aborted the stream: ${message}`);
      }
      if (text !== "Hello world") {
        throw new Error(`OpenAI SSE: expected "Hello world", got ${JSON.stringify(text)}`);
      }
    },
  );
  console.log("openai sse ok: malformed JSON and non-text events are skipped");
}

async function smokeRetrievalBodyCaps(): Promise<void> {
  const docsIndexUrl = "https://example.test/docs-search.json";
  const docsCorpusUrl = "https://example.test/llms-full.txt";
  const sourceIndexUrl = "https://example.test/source-index.jsonl";
  const githubIndexUrl = "https://example.test/github-search.jsonl";
  const rawUrl = "https://example.test/raw/huge.ts";
  const env: Env = {
    OPENAI_API_KEY: "test",
    DOCS_INDEX_URL: docsIndexUrl,
    DOCS_CORPUS_URL: docsCorpusUrl,
    SOURCE_INDEX_URL: sourceIndexUrl,
    GITHUB_INDEX_URL: githubIndexUrl,
  };
  const sourceIndex = `${JSON.stringify({
    path: "src/huge.ts",
    search: "huge source implementation file ".repeat(80),
    rawUrl,
    url: "https://github.com/openclaw/openclaw/blob/main/src/huge.ts",
  })}\n`;

  const corpusPulled = { bytes: 0 };
  const corpusTotal = maxWorkspaceTextBytes + 2_000_000;
  await withMockNetwork(
    async (url) => {
      if (url === docsCorpusUrl) return new Response(trackedStream(corpusTotal, corpusPulled));
      return new Response("missing", { status: 404 });
    },
    async () => {
      await buildWorkspace(env, "obscure fallback phrase");
    },
  );
  assertCappedRead("docs corpus loadText", corpusPulled.bytes, corpusTotal, maxWorkspaceTextBytes);

  const jsonlPulled = { bytes: 0 };
  const jsonlTotal = maxJsonlStreamBytes + 2_000_000;
  await withMockNetwork(
    async (url) => {
      if (url === sourceIndexUrl) {
        return new Response(trackedStream(jsonlTotal, jsonlPulled, 65_536, true));
      }
      return new Response("missing", { status: 404 });
    },
    async () => {
      await buildWorkspace(env, "huge source implementation");
    },
  );
  assertCappedRead("source JSONL stream", jsonlPulled.bytes, jsonlTotal, maxJsonlStreamBytes);

  const rawText = "漢".repeat(maxSourceRawChars + 4096);
  const rawBytes = new TextEncoder().encode(rawText);
  const rawPulled = { bytes: 0 };
  let sourceContent = "";
  await withMockNetwork(
    async (url) => {
      if (url === sourceIndexUrl) return new Response(sourceIndex);
      if (url === rawUrl) return new Response(trackedBytes(rawBytes, rawPulled, 4096));
      return new Response("missing", { status: 404 });
    },
    async () => {
      const files = await buildWorkspace(env, "huge source implementation");
      const source = files.find((file) => file.kind === "source");
      if (!source) {
        throw new Error("retrieval body cap: source file was not mounted");
      }
      sourceContent = source.content;
    },
  );
  assertCappedRead(
    "source rawUrl loadText",
    rawPulled.bytes,
    rawBytes.byteLength,
    maxSourceRawBytes,
  );
  if (!sourceContent.includes("漢".repeat(maxSourceRawChars))) {
    throw new Error("retrieval body cap: multibyte source lost part of the context window");
  }
  console.log("retrieval body cap ok: corpus, JSONL, and rawUrl reads stay under caps");
}

function assertCappedRead(label: string, pulled: number, total: number, cap: number): void {
  if (pulled >= total) {
    throw new Error(`${label}: read entire ${total} byte body; expected stop near ${cap}`);
  }
  if (pulled > cap + 131_072) {
    throw new Error(`${label}: read ${pulled} bytes, far past cap ${cap}`);
  }
  if (pulled < 1) {
    throw new Error(`${label}: read no bytes`);
  }
}

function trackedStream(
  totalBytes: number,
  counter: { bytes: number },
  chunkSize = 65_536,
  lineDelimited = false,
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - sent);
      counter.bytes += n;
      sent += n;
      const chunk = new Uint8Array(n).fill(65);
      if (lineDelimited) chunk[n - 1] = 10;
      controller.enqueue(chunk);
    },
  });
}

function trackedBytes(
  bytes: Uint8Array,
  counter: { bytes: number },
  chunkSize: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      counter.bytes += chunk.byteLength;
      offset = end;
      controller.enqueue(chunk);
    },
  });
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
