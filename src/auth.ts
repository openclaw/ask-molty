const canonicalDocsOrigin = "https://clawhub.ai";
const docsOriginAliases = new Map([["https://hub.openclaw.ai", canonicalDocsOrigin]]);

export const allowedOrigins = new Set([
  canonicalDocsOrigin,
  ...docsOriginAliases.keys(),
  "https://documentation.openclaw.ai",
  "http://documentation.openclaw.ai",
  "https://docs.openclaw.ai",
  "http://docs.openclaw.ai",
  "https://openclaw.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

export function normalizeDocsReturnTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    if (!allowedOrigins.has(target.origin)) return null;
    if (!["http:", "https:"].includes(target.protocol)) return null;
    const canonicalOrigin = docsOriginAliases.get(target.origin);
    if (canonicalOrigin) {
      const canonical = new URL(canonicalOrigin);
      target.protocol = canonical.protocol;
      target.host = canonical.host;
    }
    return target.href;
  } catch {
    return null;
  }
}
