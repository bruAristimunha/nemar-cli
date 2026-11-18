import { describe, expect, test } from "bun:test";
import { looksLikeDatasetId, resolveUserDatasetArgs } from "../src/lib/user-dataset-args.js";

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

  test("accepts ds and xx prefixes", () => {
    expect(resolveUserDatasetArgs("xx099900", "alice").datasetId).toBe("xx099900");
    expect(resolveUserDatasetArgs("alice", "ds004000").datasetId).toBe("ds004000");
  });

  test("throws when neither looks like a dataset id", () => {
    expect(() => resolveUserDatasetArgs("alice", "bob")).toThrow("<username> <dataset-id>");
  });

  test("rejects malformed ids", () => {
    expect(looksLikeDatasetId("nm00028")).toBe(false);
    expect(looksLikeDatasetId("nm0002890")).toBe(false);
    expect(looksLikeDatasetId("mordyan")).toBe(false);
  });
});
