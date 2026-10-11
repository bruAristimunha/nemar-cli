/**
 * Upload steps 9 to 11 as one unit: copy the data to the remote, write the NEMAR
 * metadata, save. They are one function so that what passes between them (the
 * annexed paths the copy listed, the remote the save must check against) is code that
 * can be run, rather than two lines in a command action nothing drives.
 */

import chalk from "chalk";
import type { NemarMetadataPayload } from "../api/datasets.js";
import { clearStaleFlags } from "../git-annex/clone-push.js";
import type { UploadProgress } from "../upload-progress.js";
import { saveDatasetStep, writeNemarMetadata } from "./finalize.js";
import {
  type OpenRemote,
  S3_REMOTE_NAME,
  type UploadFileEntry,
  uploadDataToS3,
} from "./transfer.js";
import { type DatasetInfo, FAIL, type Step, ok } from "./types.js";

export interface DataStepsArgs {
  absolutePath: string;
  options: { jobs: string; annexJobs?: string };
  dataFiles: UploadFileEntry[];
  filesToUpload: Array<{ path: string; size: number; mtimeMs?: number }>;
  uploadProgress: UploadProgress | null;
  datasetInfo: DatasetInfo;
  coAuthorEnrichment: NemarMetadataPayload | undefined;
  author: { name: string; email: string } | undefined;
}

/**
 * Hooks for tests. `openRemote` replaces how the remote is opened, `skipMinBytes`
 * lets a small tree reach the large-tree branch of the save, and `saveStep` is the
 * save to call (defaulting to the real one) so a test can see what it was handed.
 * The inactivity threshold shortens the real save subprocess timer, and the
 * optional spinner stream captures Ora's actual output without replacing it.
 */
export interface DataStepsDeps {
  openRemote?: OpenRemote;
  skipMinBytes?: number;
  saveStep?: typeof saveDatasetStep;
  saveInactivityWarningAfterMs?: number;
  saveSpinnerStream?: NodeJS.WritableStream;
}

export async function runDataSteps(
  args: DataStepsArgs,
  deps: DataStepsDeps = {},
): Promise<Step<UploadProgress>> {
  // Before anything asks git to look at a file. A previous run killed inside the save
  // leaves assume-unchanged flags in the index; `git annex add` on a flagged file exits 0
  // and changes nothing, so an edit made since would be stamped as uploaded and never
  // tracked, copied or committed, and the run would say it saved.
  const flags = await clearStaleFlags(args.absolutePath);
  if (!flags.success) {
    // `flags.error` is the whole account (what failed, why it matters, what to do).
    console.log(chalk.red(flags.error));
    console.log(chalk.yellow("Re-run the same command to retry."));
    return FAIL;
  }
  if (flags.cleared > 0) {
    console.log(
      chalk.yellow(
        `  Cleared ${flags.cleared} assume-unchanged flag(s) an earlier, interrupted save left on annexed files`,
      ),
    );
  }

  // Step 9: Upload data files to S3 via the git-annex S3 special remote
  const uploaded = await uploadDataToS3(
    args.absolutePath,
    args.options,
    args.dataFiles,
    args.filesToUpload,
    args.uploadProgress,
    args.datasetInfo,
    { openRemote: deps.openRemote },
  );
  if (uploaded.status === "fail") return FAIL;
  const { progress, annexedPaths } = uploaded.value;

  // Step 10b: Ensure .nemar metadata is on disk and .bidsignore covers it
  writeNemarMetadata(args.absolutePath, args.coAuthorEnrichment, progress);

  // Step 11: Save dataset changes. The annexed set the copy listed spares the save a
  // walk of the tree, and the remote lets it fail on anything the save itself annexed.
  const save = deps.saveStep ?? saveDatasetStep;
  const saved = await save(args.absolutePath, args.author, progress, {
    annexedPaths,
    verifyRemote: S3_REMOTE_NAME,
    ...(deps.skipMinBytes === undefined ? {} : { skipMinBytes: deps.skipMinBytes }),
    ...(deps.saveInactivityWarningAfterMs === undefined
      ? {}
      : { inactivityWarningAfterMs: deps.saveInactivityWarningAfterMs }),
    ...(deps.saveSpinnerStream === undefined ? {} : { spinnerStream: deps.saveSpinnerStream }),
  });
  if (saved.status === "fail") return FAIL;
  return ok(progress);
}
