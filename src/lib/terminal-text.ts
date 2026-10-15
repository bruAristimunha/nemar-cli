/**
 * Text that came from the network, made safe and short for a terminal. Moved out of
 * `commands/admin-pr-reviews.ts` (which re-exports `plain` and `ageOf`) so the publication
 * review's commands print under the same rule as the pull-request review's.
 */

/**
 * Text that came from the network, made safe for a terminal: control characters (an ESC sequence
 * can rewrite the screen), zero-width and bidirectional-override characters are removed. The
 * server already reduces author-controlled text to plain words; this is the second line, because a
 * terminal should not depend on a server's hygiene alone.
 */
export function plain(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "") : "";
}

/** {@link plain}, cut to `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  const p = plain(s);
  return p.length > max ? `${p.slice(0, max - 1)}…` : p;
}

/** How long ago, in the unit that reads best: `12m`, `5h`, `9d`. */
export function ageOf(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
