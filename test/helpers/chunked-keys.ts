/**
 * Vectors shared by the chunked-key tests (test/annex-key.unit.test.ts,
 * test/chunked-key-availability.unit.test.ts and
 * backend/test/import-integrity-chunked.test.ts).
 *
 * One key, `BASE_EEG`, of 2,500,000,000 bytes, chunked at 1 GiB: two full chunks
 * and a 352,516,352-byte remainder. Data only; nothing here runs a test.
 */

export const GiB = 1073741824;
export const MiB512 = 536870912;
export const BASE_EEG = "SHA256E-s2500000000--abc.eeg";
export const LAST = 2500000000 - 2 * GiB;

export type Entries = [string, number][];

/** Chunk object name for an `abc.eeg` key of `size` bytes at an arbitrary chunk size. */
export const chunkAt = (size: number, chunkSize: number, n: number) =>
  `SHA256E-s${size}-S${chunkSize}-C${n}--abc.eeg`;

/** Chunk `n` of BASE_EEG at 1 GiB. */
export const chunk = (n: number) => chunkAt(2500000000, GiB, n);

/** BASE_EEG at 1 GiB, every chunk in place: two full chunks and the remainder. */
export const complete1G = (): Entries => [
  [chunk(1), GiB],
  [chunk(2), GiB],
  [chunk(3), LAST],
];
