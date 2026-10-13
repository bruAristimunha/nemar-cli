// Capture what code logs through console.log, console.warn and console.error, so a test can prove
// a log line carries only ids and closed words. Observation only: the code under test runs
// unchanged, and all three functions are restored whatever happens. console.log is captured too:
// a line written there is as public as any other, and a capture blind to it would pass a leak.

/** Run `fn` and return every line it logged through console.log, console.warn or console.error. */
export async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const { log, warn, error } = console;
  const take = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = take;
  console.warn = take;
  console.error = take;
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
  return lines;
}
