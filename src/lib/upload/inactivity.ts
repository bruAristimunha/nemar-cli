import chalk from "chalk";
import type { Ora } from "ora";

export function describeInactivityDuration(idleMs: number): string {
  if (idleMs < 1_000) return `about ${Math.max(1, Math.round(idleMs))} ms`;
  const minutes = Math.round(idleMs / 60_000);
  if (minutes > 0) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = Math.round(idleMs / 1_000);
  return `about ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function persistSpinnerWarning(spinner: Ora, warning: string): Ora {
  const activeText = spinner.text;
  spinner.info(chalk.yellow(warning));
  // Ora exposes this getter at runtime, but omits it from its public TypeScript interface.
  if ((spinner as Ora & { readonly isEnabled: boolean }).isEnabled) spinner.start(activeText);
  return spinner;
}
