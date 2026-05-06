#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist", "test");
const required = [
  "docs-search.jsonl",
  "source-search.jsonl",
  "github-search.jsonl",
  "workspace-manifest.json",
];

for (const rel of required) {
  const file = path.join(outDir, rel);
  if (!fs.existsSync(file)) throw new Error(`missing ${rel}`);
  if (fs.statSync(file).size < 10) throw new Error(`empty ${rel}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "workspace-manifest.json"), "utf8"));
const fileCount = Object.keys(manifest.files ?? {}).length;
if (fileCount < 1000) throw new Error(`workspace too small: ${fileCount} files`);

const source = fs.readFileSync(path.join(outDir, "source-search.jsonl"), "utf8");
if (!source.includes("model-selection"))
  throw new Error("source index did not include model-selection");

const github = fs.readFileSync(path.join(outDir, "github-search.jsonl"), "utf8");
if (!github.includes("github.com/openclaw/openclaw"))
  throw new Error("github index missing OpenClaw links");

console.log(`ask-molty smoke ok: ${fileCount} workspace files`);
