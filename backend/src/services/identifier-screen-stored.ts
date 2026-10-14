/**
 * How a publication request's stored identifier screen is read back (ADR 0086): the state column
 * and the report column, neither trusted.
 *
 * These two functions are the only way any decision reads the screen's state or its screened
 * commit; the approval gate, the status views and the publication review (ADR 0102) all go
 * through them and `screenGate`. They live in a module of their own, with what reads a stored
 * screen and nothing that mails or writes one, so the review can import them without importing
 * `identifier-screen.ts`, which in turn waits for the review before it mails.
 * `identifier-screen.ts` re-exports everything here, so its importers are unchanged.
 *
 * The sandbox exemption lives here too, for the same reason: the review's view must decide it
 * exactly as the screen does, and a copy kept equal by a test is a second place to forget. So does
 * {@link screenView}, which the detail view of the review carries beside the list's: one reading
 * of a row's screen for every surface that shows it.
 */

import {
  type ScreenDescription,
  type ScreenReport,
  type ScreenState,
  describeScreen,
  isScreenState,
  parseScreenReport,
} from "../../../shared/identifier-screen-report.js";
import { isSandboxDatasetId } from "./datasetId.js";

/**
 * Sandbox (`xx`) datasets are not screened: the band is training and staging
 * exemplars, which never publish real data (ADR 0068's bands). The same rule
 * `isSandboxDatasetId` states, used by name so the exemption reads as a policy.
 */
export function isScreenExempt(datasetId: string): boolean {
  // A well-formed `xx` id only: anything else is screened, never waved through
  // because it happens to start with the letters.
  return /^xx\d{6}$/.test(datasetId) && isSandboxDatasetId(datasetId);
}

/** The stored status column, read without trusting it: anything that is not a state is null. */
export function readStoredState(raw: unknown): ScreenState | null {
  return isScreenState(raw) ? raw : null;
}

/**
 * The stored report column, re-validated on the way out. The Worker only ever
 * writes a parsed report, so a failure here means the row was edited by hand;
 * it reads as "no report", which every reader treats as not clear.
 */
export function readStoredReport(raw: unknown): ScreenReport | null {
  if (typeof raw !== "string") return null;
  try {
    return parseScreenReport(JSON.parse(raw));
  } catch (err) {
    // The parser's own fixed word, never its input, so a hand-edited row is not silent.
    const code = err instanceof Error && err.name === "ReportError" ? err.message : "unparseable";
    console.warn(`[identifier-screen] a stored report does not read back (${code})`);
    return null;
  }
}

/** What an exempt dataset's email and status say about the screen. Worker-fixed words. */
export const EXEMPT_SCREEN_DESCRIPTION: ScreenDescription = {
  headline: "Identifier screen: not applicable (sandbox)",
  tone: "note",
  lines: ["Sandbox (xx) datasets never publish real data, so they are not screened."],
};

/** The screen as a status view shows it. */
export interface ScreenView {
  /** The stored state; `exempt` for a sandbox dataset; null when no screen was started. */
  state: ScreenState | "exempt" | null;
  headline: string;
  tone: ScreenDescription["tone"];
  lines: string[];
}

/** One reading of a row's screen, for every surface that shows it. */
export function screenView(datasetId: string, rawStatus: unknown, rawReport: unknown): ScreenView {
  if (isScreenExempt(datasetId)) return { state: "exempt", ...EXEMPT_SCREEN_DESCRIPTION };
  const state = readStoredState(rawStatus);
  const report = state === null ? null : readStoredReport(rawReport);
  const d = describeScreen(state, report);
  return { state, headline: d.headline, tone: d.tone, lines: d.lines };
}
