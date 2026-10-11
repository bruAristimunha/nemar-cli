/**
 * Run upload steps 9 to 11 (`runDataSteps`) in a process of their own, with a git-annex
 * `directory` remote called `nemar-s3`, so a test can have that process killed.
 *
 * usage: bun run data-steps-runner.ts <dataset dir> <pid file> <store dir>
 *
 * It writes its own pid to the pid file first (a pre-commit hook reads it to kill this
 * process in the middle of the save), runs with the save's skip open (`skipMinBytes: 1`)
 * so the paths ARE marked assume-unchanged while it is killed, and prints the result as
 * one JSON line if it lives to.
 */

import { writeFileSync } from "node:fs";
import { runCommand } from "../../src/lib/git-annex/run-command";
import { annexRemoteExists } from "../../src/lib/git-annex/s3-remote";
import { collectFileManifest } from "../../src/lib/git-annex/transfer";
import { runDataSteps } from "../../src/lib/upload/data-steps";
import { computeFilesToUpload, prepareUploadProgress } from "../../src/lib/upload/plan";
import { S3_REMOTE_NAME } from "../../src/lib/upload/transfer";
import { ok } from "../../src/lib/upload/types";

const [dir, pidFile, store] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));

const manifest = await collectFileManifest(dir);
const { dataFiles, uploadProgress } = prepareUploadProgress(dir, manifest, {});
const result = await runDataSteps(
  {
    absolutePath: dir,
    options: { jobs: "2" },
    dataFiles,
    filesToUpload: computeFilesToUpload(uploadProgress, dataFiles),
    uploadProgress,
    datasetInfo: {
      dataset_id: "nm000996",
      ssh_url: "git@github.com:nemarDatasets/nm000996.git",
      s3_prefix: "nm000996/objects",
      github_url: "https://github.com/nemarDatasets/nm000996",
      upload_urls: {},
      s3_config: {
        bucket: "nemar-test",
        region: "us-east-2",
        public_url: "https://example.invalid",
      },
    },
    coAuthorEnrichment: undefined,
    author: undefined,
  },
  {
    skipMinBytes: 1,
    openRemote: async () => {
      if (!(await annexRemoteExists(dir, S3_REMOTE_NAME))) {
        const init = await runCommand(
          [
            "git",
            "annex",
            "initremote",
            S3_REMOTE_NAME,
            "type=directory",
            `directory=${store}`,
            "encryption=none",
          ],
          { cwd: dir },
        );
        if (init.exitCode !== 0) throw new Error(init.stderr);
      }
      return ok({ remoteIdentity: `directory:${store}` });
    },
  },
);
console.log(JSON.stringify({ status: result.status }));
