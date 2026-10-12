#!/usr/bin/env bash
set -euo pipefail

node --input-type=module <<'JS'
import assert from "node:assert/strict";
import fs from "node:fs";
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
assert.equal(lock.version, manifest.version, "lockfile version must match package.json");
assert.equal(lock.packages[""].version, manifest.version, "root lock package version must match");
JS
npm ci
npm run build
npm run lint
npm run format:check
# The exact-commit push CI gates the full docs/source/Gitcrawl export as well.
ASK_MOLTY_SKIP_EXPORT_SMOKE=1 npm run smoke
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir "$build_dir"
test -s "$build_dir/worker.js"
