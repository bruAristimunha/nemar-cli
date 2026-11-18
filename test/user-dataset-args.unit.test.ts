import { describe, expect, test } from "bun:test";
import { USER_DATASET_ARGS_ERROR, resolveUserDatasetArgs } from "../src/lib/user-dataset-args.js";

describe("resolveUserDatasetArgs", () => {
  test("keeps the declared order", () => {
    expect(resolveUserDatasetArgs("mordyan", "nm000289")).toEqual({
      username: "mordyan",
      datasetId: "nm000289",
    });
  });

  test("swaps when the dataset id comes first", () => {
    expect(resolveUserDatasetArgs("nm000289", "psong")).toEqual({
      username: "psong",
      datasetId: "nm000289",
    });
  });

  test("normalizes an uppercase id in either slot", () => {
    expect(resolveUserDatasetArgs("alice", "NM000289")).toEqual({
      username: "alice",
      datasetId: "nm000289",
    });
    expect(resolveUserDatasetArgs("NM000289", "alice")).toEqual({
      username: "alice",
      datasetId: "nm000289",
    });
  });

  test("trims surrounding whitespace on the id", () => {
    expect(resolveUserDatasetArgs("alice", "  xx099900 ")?.datasetId).toBe("xx099900");
  });

  test("keeps the declared order when both look like ids", () => {
    expect(resolveUserDatasetArgs("nm000289", "xx099900")).toEqual({
      username: "nm000289",
      datasetId: "xx099900",
    });
  });

  test("rejects out-of-bound, ds-prefixed, malformed and empty ids", () => {
    expect(resolveUserDatasetArgs("alice", "nm900001")).toBeNull();
    expect(resolveUserDatasetArgs("alice", "ds004000")).toBeNull();
    expect(resolveUserDatasetArgs("alice", "nm00028")).toBeNull();
    expect(resolveUserDatasetArgs("alice", "")).toBeNull();
    expect(resolveUserDatasetArgs("", "")).toBeNull();
    expect(resolveUserDatasetArgs("alice", "bob")).toBeNull();
  });

  test("the failure message names the expected form and an example id", () => {
    expect(USER_DATASET_ARGS_ERROR).toContain("<username> <dataset-id>");
    expect(USER_DATASET_ARGS_ERROR).toContain("nm000104");
  });
});
