const canonicalDocsOrigin = "https://docs.clawhub.ai";
const legacyClawHubOrigins = new Set(["https://clawhub.ai", "https://hub.openclaw.ai"]);

export const allowedOrigins = new Set([
  canonicalDocsOrigin,
  ...legacyClawHubOrigins,
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
    if (legacyClawHubOrigins.has(target.origin)) {
      if (target.pathname !== "/docs" && !target.pathname.startsWith("/docs/")) return null;
      const canonical = new URL(canonicalDocsOrigin);
      target.protocol = canonical.protocol;
      target.host = canonical.host;
      target.pathname = target.pathname.slice("/docs".length) || "/";
    }
    return target.href;
  } catch {
    return null;
  }
}
