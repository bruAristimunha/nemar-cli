/**
 * Lines typed at the terminal, one question at a time, for a command that asks many.
 *
 * `inquirer` (see `confirm.ts`) is built for one question and refuses a stdin that is not a
 * terminal. A loop that asks "approve, close, comment?" about each of a dozen pull requests wants
 * the opposite: one reader for the whole run, so a line that arrives early is kept for the next
 * question and not lost, and an input that ends (Ctrl+D, Ctrl+C or a closed pipe) is an answer
 * the caller can see (`null`), never a hang.
 *
 * **Type-ahead is kept for a script and discarded for a person.** Piped input is a script: every
 * answer is there at once and each belongs to the question it lines up with. A person at a terminal
 * who presses Enter while the program is busy (after a `y` it approves, merges and reads the next
 * pull request, which takes seconds) is answering a screen that has not been drawn; keeping that
 * line would answer the NEXT card, unseen. So with `typeAhead: "discard"`, the default for a
 * terminal, the caller drops what arrived before it showed the question (`discardTyped`).
 */

import { type Interface, createInterface } from "node:readline";

export interface LineReaderOptions {
  /** `keep` queues lines typed before a question is asked; `discard` lets the caller drop them. */
  typeAhead?: "keep" | "discard";
}

/**
 * How long a terminal waits, after the line that answered a prompt for free text, for the rest of
 * a multi-line paste to arrive before it decides the answer was one line (`discardTyped`). A paste
 * reaches the program in pieces a few milliseconds apart, so the window must outlast the slowest
 * gap a loaded machine produces; 250 ms is far above that and below what a person pressing Enter
 * on a reason or a comment notices. One value for every command that asks for free text.
 */
export const PASTE_SETTLE_MS = 250;

export class LineReader {
  private readonly rl: Interface;
  private readonly lines: string[] = [];
  private readonly waiting: Array<(line: string | null) => void> = [];
  private readonly output: NodeJS.WritableStream;
  private readonly typeAhead: "keep" | "discard";
  private ended = false;
  private wasInterrupted = false;

  constructor(
    input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
    options: LineReaderOptions = {},
  ) {
    this.output = output;
    this.typeAhead = options.typeAhead ?? (input.isTTY === true ? "discard" : "keep");
    this.rl = createInterface({ input, output, terminal: input.isTTY === true });
    this.rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.lines.push(line);
    });
    // Ctrl+C ends the input like Ctrl+D does, and anything typed before it is not an answer.
    this.rl.on("SIGINT", () => this.interrupt());
    this.rl.on("close", () => {
      this.ended = true;
      for (const next of this.waiting.splice(0)) next(null);
    });
  }

  /** False once the input has ended (Ctrl+D, Ctrl+C, a closed pipe) or the reader was closed. */
  get open(): boolean {
    return !this.ended;
  }

  /**
   * Whether a question asked now could still be answered: the input is open, or it has ended with
   * lines it left behind (a piped script is read to its end at once, with every answer waiting). False
   * after Ctrl+C, which clears them, and once the last of them was taken.
   */
  get canAnswer(): boolean {
    return !this.wasInterrupted && (!this.ended || this.lines.length > 0);
  }

  /** True once Ctrl+C ended the input, so the caller can say "interrupted" and not "input ended". */
  get interrupted(): boolean {
    return this.wasInterrupted;
  }

  /**
   * End the input as Ctrl+C does: interrupted, nothing queued is an answer, and the reader closes.
   * For a caller that heard the interrupt somewhere else (a SIGINT event while it was busy).
   */
  interrupt(): void {
    this.wasInterrupted = true;
    this.lines.length = 0;
    this.rl.close();
  }

  /** Print `prompt` and return the next line typed, or null once the input has ended. */
  ask(prompt: string): Promise<string | null> {
    if (this.wasInterrupted) return Promise.resolve(null);
    const queued = this.lines.shift();
    if (queued !== undefined) {
      this.output.write(`${prompt}${queued}\n`);
      return Promise.resolve(queued);
    }
    if (this.ended) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * Drop the lines that arrived before the caller asked, and say how many. Only when type-ahead is
   * `discard` (a terminal): a pipe is a script and its queue is the script. `settleMs` waits a
   * moment first, so the rest of a multi-line paste has arrived and is dropped with its first line.
   */
  async discardTyped(settleMs = 0): Promise<number> {
    if (this.typeAhead !== "discard") return 0;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const dropped = this.lines.length;
    this.lines.length = 0;
    return dropped;
  }

  close(): void {
    this.rl.close();
  }
}
