/**
 * How the terminal prints a publication request's identifier screen (epic
 * #1610, phase 4).
 *
 * NOTHING IS DERIVED HERE. The backend sends `identifier_screen` as
 * `describeScreen` (shared/identifier-screen-report.ts) worded it: a headline, a
 * tone and count lines. This module owns only colour and indentation, so
 * `nemar dataset publish status`, `nemar admin repo publish list` and the admin email
 * cannot say different things about one screen.
 *
 * The one thing set apart is the acquisition-date warning (ADR 0090): its lines are
 * recognized by `isDateWarningLine`, which owns the wording, and printed in the
 * warning color instead of the dim of a count line. Which lines they are is not
 * decided here.
 */

import chalk from "chalk";
import { isDateWarningLine } from "../../shared/identifier-screen-report.js";

/** The `identifier_screen` field of the status and list responses. */
export interface IdentifierScreenView {
  state: string | null;
  headline: string;
  tone: "ok" | "note" | "warn" | "stop";
  lines: string[];
}

const TONE: Record<IdentifierScreenView["tone"], (text: string) => string> = {
  ok: chalk.green,
  note: chalk.cyan,
  warn: chalk.yellow,
  stop: chalk.red,
};

/**
 * The headline and its lines, `indent` spaces in. Returns nothing for a view an
 * older backend did not send: absent is "this server does not screen", which is
 * not the same thing as a screen that did not run, and is not printed as one.
 */
export function identifierScreenLines(
  view: IdentifierScreenView | undefined,
  indent = 2,
): string[] {
  if (!view || typeof view.headline !== "string") return [];
  const pad = " ".repeat(indent);
  const color = TONE[view.tone] ?? chalk.white;
  const out = [`${pad}${color(view.headline)}`];
  for (const line of Array.isArray(view.lines) ? view.lines : []) {
    out.push(`${pad}  ${isDateWarningLine(line) ? chalk.yellow(line) : chalk.dim(line)}`);
  }
  return out;
}
