/**
 * The scale gate of the change summary (design `.context/plans/pr-review-change-summary.md`, section
 * 12.4): no evidence pass takes more than 60 seconds on a synthetic 2,000-file pull request read
 * from a blob-less clone, the way the review job reads one.
 *
 * One `git fast-import` writes the pull request (2,000 modified tables and sidecars, the most the
 * content pass compares for a cosmetic change, and 300 added copies), a bare origin serves it over
 * `file://`, and the clone fetches it with `--filter=blob:none`, so the content pass's one batched
 * prefetch is a real fetch. The temporary directory is removed after the file, passed or not.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherContent, gatherListing } from "../scripts/ci/pr-review-evidence";
import { blobLessClone, tree, writeRepository } from "./fixtures/pr-review-hostile/build";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pr-review-scale-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const pad = (n: number) => String(n).padStart(4, "0");
const CH = "name\ttype\tunits\tlow_cutoff\thigh_cutoff";
const row = (name: string) => `${name}\tEEG\tuV\t0.1\t100`;

test("a 2,000-file pull request is read within the passes' 60 seconds, and 1,500 files are accounted for", () => {
  const base: Record<string, string> = {
    "dataset_description.json": '{"Name":"Scale","BIDSVersion":"1.9.0","Version":"1.0.0"}\n',
  };
  const head: Record<string, string> = { ...base };
  // 1,000 channel tables whose names gain a prefix; in 300 of them one row moves verbatim to
  // sourcedata/moved/<the same path>.
  for (let s = 1; s <= 1000; s++) {
    const path = `sub-${pad(s)}/eeg/sub-${pad(s)}_task-rest_channels.tsv`;
    const names = ["Fp1", "Fp2", "C3", "C4", "Cz"].map((n) => `${n}s${pad(s)}`);
    base[path] = `${CH}\n${names.map(row).join("\n")}\n`;
    const moved = s <= 300 ? [names[4] as string] : [];
    const kept = names.filter((n) => !moved.includes(n));
    head[path] = `${CH}\n${kept.map((n) => row(`POL ${n}`)).join("\n")}\n`;
    if (moved.length > 0)
      head[`sourcedata/moved/${path}`] = `${CH}\n${moved.map(row).join("\n")}\n`;
  }
  // 500 sidecars with a value changed.
  for (let s = 1; s <= 500; s++) {
    const path = `sub-${pad(s)}/eeg/sub-${pad(s)}_task-rest_eeg.json`;
    base[path] = `{"TaskName":"rest","SamplingFrequency":500,"RecordingDuration":${s}}\n`;
    head[path] = `{"TaskName":"rest","SamplingFrequency":512,"RecordingDuration":${s}}\n`;
  }
  // 500 events tables, each made ragged and each losing a different row: refused, read as diffs.
  for (let s = 1; s <= 500; s++) {
    const path = `sub-${pad(s)}/eeg/sub-${pad(s)}_task-rest_events.tsv`;
    base[path] = `onset\tduration\ttrial_type\n${s}.0\t1\tgo\n${s}.5\t1\tstop\n`;
    head[path] = `onset\tduration\ttrial_type\n${s}.5\t1\tstop\textra\n`;
  }
  const source = join(root, "source");
  const { base: b, head: h } = writeRepository(source, tree(base), tree(head));
  const clone = blobLessClone(source, join(root, "clone"), [b, h]);

  const startedListing = performance.now();
  const listing = gatherListing(clone, b, h);
  const listingMs = performance.now() - startedListing;
  const startedContent = performance.now();
  const content = gatherContent(clone, listing);
  const contentMs = performance.now() - startedContent;

  expect(listing.changes).toHaveLength(2_300);
  expect(listingMs).toBeLessThan(60_000);
  expect(contentMs).toBeLessThan(60_000);
  expect(content.summary.abandoned).toBe(false);
  expect(content.summary.facts.files_summarized).toBe(1_500);
  expect(content.summary.facts.files_not_summarized).toBe(500);
  expect(content.summary.accounted.size).toBe(1_500);
  expect(content.summary.loss.rowsRelocated).toBe(300);
  expect(content.summary.loss.rowsRemoved).toBe(0);
  // The 500 refused tables are read as diffs, 40 shown and the rest unread.
  expect(content.unreadFiles).toBe(460);
}, 180_000);
