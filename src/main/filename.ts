/** Ported from the web app's app/lib/filename.ts. */
export function sanitizeFilename(rawName: string): string {
  // Characters Windows forbids, plus control characters that break shells and
  // trailing dots/spaces, which Windows silently strips.
  const sanitized = rawName
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return sanitized || "datei";
}
