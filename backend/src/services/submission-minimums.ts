// The submission minimums (ADR 0026) live in `shared/submission-minimums.ts`, so the Worker and
// the publication review job (ADR 0102) evaluate one function. Re-exported here so every
// existing import keeps working.
export * from "../../../shared/submission-minimums.js";
