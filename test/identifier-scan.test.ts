/**
 * Identifier screening (`shared/identifier-scan.ts`).
 *
 * Headers are built to the EDF/BDF layout byte for byte, and one real EDF from
 * `test/fixtures/bids-minimal` goes through the same entry point, so a parser that
 * only agrees with its own builder cannot pass. Every "flagged" case has a clean twin
 * differing in exactly one field, because a checker that flags everything also passes
 * a flagged-case test.
 *
 * The values in these headers are invented. What the tests protect is that a finding
 * carries a SHAPE and never the value: each flagged case asserts the serialized
 * findings do not contain the injected text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATE_KINDS,
  DIRECT_KINDS,
  EDF_HEADER_BYTES,
  type Shape,
  countByKind,
  detectEdfFamily,
  formatCoverage,
  scanAcqTime,
  scanEdfHeader,
  scanJsonKeys,
  scanParticipantIds,
  scanPaths,
  scanTableColumns,
  scanTextForLocalPaths,
  shapeOf,
} from "../shared/identifier-scan";

interface HeaderFields {
  family?: "edf" | "bdf";
  patient?: string;
  recording?: string;
  startdate?: string;
  /** BDF files from some vendors pad with NUL rather than spaces. */
  pad?: "space" | "nul";
}

function buildHeader(f: HeaderFields = {}): Uint8Array {
  const out = new Uint8Array(EDF_HEADER_BYTES).fill(0x20);
  const padByte = f.pad === "nul" ? 0x00 : 0x20;
  const put = (text: string, start: number, width: number) => {
    out.fill(padByte, start, start + width);
    for (let i = 0; i < Math.min(text.length, width); i++) out[start + i] = text.charCodeAt(i);
  };
  if ((f.family ?? "edf") === "bdf") {
    out[0] = 0xff;
    for (let i = 0; i < 7; i++) out[1 + i] = "BIOSEMI".charCodeAt(i);
  } else {
    out[0] = "0".charCodeAt(0);
  }
  put(f.patient ?? "X X X X", 8, 80);
  put(f.recording ?? "Startdate X X X X", 88, 80);
  put(f.startdate ?? "01.01.85", 168, 8);
  return out;
}

const kinds = (bytes: Uint8Array) => scanEdfHeader(bytes).map((x) => x.kind);

describe("EDF/BDF header: clean headers", () => {
  test("all placeholders and the clipping date produce no findings", () => {
    expect(scanEdfHeader(buildHeader())).toEqual([]);
  });

  test("an MNE-style study code with X placeholders is clean", () => {
    expect(kinds(buildHeader({ patient: "12 X X X hand=1" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M X X_X weight=71.5 hand=1" }))).toEqual([]);
  });

  test("a birth date reduced to year only is clean; any other day is not", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 01-JAN-1990 X_X" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M 02-JAN-1990 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 M 01-FEB-1990 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
  });

  test("a start date on 1 January is year-only and clean; the 2nd is not", () => {
    expect(kinds(buildHeader({ startdate: "01.01.23" }))).toEqual([]);
    expect(kinds(buildHeader({ startdate: "02.01.23" }))).toEqual(["edf-startdate"]);
    expect(kinds(buildHeader({ startdate: "01.02.23" }))).toEqual(["edf-startdate"]);
  });

  test("a subject label in the name position is a code, not a name", () => {
    expect(kinds(buildHeader({ patient: "S_01 F X sub-01" }))).toEqual([]);
  });

  test("a blank patient field is clean", () => {
    expect(kinds(buildHeader({ patient: "" }))).toEqual([]);
  });

  test("month case and year width vary by writer and do not change the verdict", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 01-Jan-1993 X_X" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M 14-Mar-1993 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
  });

  test("descriptive words are not names: sex, handedness, group labels, 'Unknown'", () => {
    expect(kinds(buildHeader({ patient: "Subject 01 Female" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "sub-01 right handed" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 F X Unknown" }))).toEqual([]);
  });

  test("sex and a date with no name: clean when year-only, a birth date otherwise", () => {
    expect(kinds(buildHeader({ patient: "M 01-JAN-1990" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "M 14-MAR-1990" }))).toEqual(["edf-patient-birthdate"]);
  });
});

describe("EDF/BDF header: identifying headers", () => {
  const alice = "alice";

  test("a name-like code and name are flagged and never quoted", () => {
    const bytes = buildHeader({ patient: `${alice} F 01-JAN-1990 ${alice}` });
    const findings = scanEdfHeader(bytes);
    expect(findings.map((f) => f.kind).sort()).toEqual(["edf-patient-code", "edf-patient-name"]);
    expect(findings.every((f) => f.severity === "identifier")).toBe(true);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain(alice);
  });

  test("the same name with a study code in front flags only the name", () => {
    expect(kinds(buildHeader({ patient: `S_01 F 01-JAN-1990 ${alice}` }))).toEqual([
      "edf-patient-name",
    ]);
  });

  test("a real birth date is flagged and its digits are not quoted", () => {
    const findings = scanEdfHeader(buildHeader({ patient: "S_01 M 14-MAR-1993 X_X" }));
    expect(findings.map((f) => f.kind)).toEqual(["edf-patient-birthdate"]);
    expect(JSON.stringify(findings)).not.toContain("1993");
    expect(JSON.stringify(findings)).not.toContain("MAR");
  });

  test("a real header start date and recording start date are each flagged", () => {
    const bytes = buildHeader({
      startdate: "14.03.23",
      recording: "Startdate 14-MAR-2023 X X X",
    });
    expect(kinds(bytes).sort()).toEqual(["edf-recording-startdate", "edf-startdate"]);
    expect(JSON.stringify(scanEdfHeader(bytes))).not.toContain("2023");
  });

  test("a classic free-text patient field is flagged", () => {
    const findings = scanEdfHeader(buildHeader({ patient: "John Smith" }));
    expect(findings.map((f) => f.kind)).toEqual(["edf-patient-freetext"]);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain("smith");
  });

  test("an operator name in the technician slot is a review finding", () => {
    const findings = scanEdfHeader(buildHeader({ recording: "Startdate X X bob X" }));
    expect(findings).toEqual([
      {
        kind: "edf-recording-technician",
        severity: "review",
        field: "recording.technician",
        shape: "a+" as Shape,
      },
    ]);
  });

  test("BDF with NUL padding, the form some vendors write, is read the same way", () => {
    const flagged = buildHeader({
      family: "bdf",
      pad: "nul",
      patient: `${alice} F 01-JAN-1990 ${alice}`,
    });
    expect(detectEdfFamily(flagged)).toBe("bdf");
    expect(kinds(flagged).sort()).toEqual(["edf-patient-code", "edf-patient-name"]);
    expect(kinds(buildHeader({ family: "bdf", pad: "nul" }))).toEqual([]);
  });
});

describe("EDF/BDF header: a file that could not be read is never clean", () => {
  test("a truncated header is a review finding, not an empty list", () => {
    const findings = scanEdfHeader(buildHeader().slice(0, 100));
    expect(findings).toEqual([
      { kind: "edf-unreadable", severity: "review", field: "header", shape: "" as Shape },
    ]);
  });

  test("a file with another magic is unreadable, not clean", () => {
    const bytes = buildHeader();
    bytes[0] = "A".charCodeAt(0);
    expect(kinds(bytes)).toEqual(["edf-unreadable"]);
  });
});

describe("EDF/BDF header: a real EDF through the same entry point", () => {
  test("the repository's real EDF fixture has no patient or recording identifiers", () => {
    const real = readFileSync(
      join(import.meta.dir, "fixtures/bids-minimal/sub-01/eeg/sub-01_task-rest_eeg.edf"),
    ).subarray(0, EDF_HEADER_BYTES);
    expect(detectEdfFamily(real)).toBe("edf");
    const found = kinds(real);
    expect(found.filter((k) => k !== "edf-startdate" && k !== "edf-recording-startdate")).toEqual(
      [],
    );
  });
});

describe("tables, JSON and paths", () => {
  test("identifier-named columns are flagged; participant_id and age are not", () => {
    expect(scanTableColumns("participant_id\tage\tsex\thand")).toEqual([]);
    const found = scanTableColumns("\uFEFFparticipant_id\tname\tDate_Of_Birth\temail");
    expect(found.map((f) => f.field)).toEqual(["name", "dateofbirth", "email"]);
  });

  test("a populated identifier key is flagged by shape; an empty one is not", () => {
    const doc = {
      PatientName: "carol",
      PatientID: "carol",
      Address: "",
      Nested: { BirthDate: "1990-01-01T00:00:00", DeviceName: "EEG-1" },
      DataFileInformations: [{ ExamDoctor: "" }, { Contact: "555-0100" }],
    };
    const found = scanJsonKeys(doc);
    expect(found.map((f) => f.field).sort()).toEqual([
      "birthdate",
      "contact",
      "patientid",
      "patientname",
    ]);
    expect(JSON.stringify(found).toLowerCase()).not.toContain("carol");
    expect(scanJsonKeys({ Address: "", Contact: "", DeviceName: "EEG-1" })).toEqual([]);
  });

  test("author, license and tool names in metadata JSON are not participant identifiers", () => {
    const metadata = {
      authors: [{ name: "Dr A", first_name: "A", full_name: "A B", affiliations: [{ name: "U" }] }],
      license: { name: "CC0" },
      GeneratedBy: [{ Name: "moabb" }],
    };
    expect(scanJsonKeys(metadata)).toEqual([]);
  });

  test("ambiguous contact keys are review findings, patient keys are identifiers", () => {
    const found = scanJsonKeys({ Contact: "555-0100", PatientName: "dan" });
    expect(Object.fromEntries(found.map((f) => [f.field, f.severity]))).toEqual({
      contact: "review",
      patientname: "identifier",
    });
  });

  test("acq_time: a calendar date is a review finding; year-only and n/a are not", () => {
    expect(scanAcqTime("2023-03-14T10:12:00.000000Z").map((f) => f.kind)).toEqual([
      "acq-time-dated",
    ]);
    expect(scanAcqTime("n/a")).toEqual([]);
    expect(scanAcqTime("1900-01-01T00:00:00")).toEqual([]);
  });

  test("images and documents are flagged unless they follow the BIDS photo suffix", () => {
    const found = scanPaths([
      "sourcedata/sub-01/ses-01/eeg/someone.jpg",
      "sub-01/eeg/sub-01_photo.jpg",
      "sourcedata/consent.pdf",
      "sourcedata/code/.idea/misc.xml",
      "code/__pycache__/x.cpython-37.pyc",
      "sub-01/eeg/sub-01_task-rest_eeg.edf",
      "README.md",
    ]);
    expect(found.map((f) => f.kind).sort()).toEqual([
      "image-or-document-file",
      "image-or-document-file",
      "tooling-debris",
      "tooling-debris",
    ]);
    expect(JSON.stringify(found)).not.toContain("someone");
  });

  test("local user paths are found without being quoted", () => {
    const found = scanTextForLocalPaths('open("C:\\\\Users\\\\dave\\\\data.csv")');
    expect(found.map((f) => f.kind)).toEqual(["local-user-path"]);
    expect(JSON.stringify(found)).not.toContain("dave");
    expect(scanTextForLocalPaths("/Users/erin/work/x.py").length).toBe(1);
    expect(scanTextForLocalPaths("relative/path/x.py")).toEqual([]);
  });
});

describe("coverage and summaries", () => {
  test("recording formats this module cannot read are counted, never silently skipped", () => {
    const cov = formatCoverage([
      "sub-01/eeg/a.edf",
      "sub-01/eeg/b.BDF",
      "sub-02/eeg/c.set",
      "sub-02/eeg/c.fdt",
      "sub-03/meg/d.fif.gz",
      "sub-03/anat/t1.nii.gz",
      "participants.tsv",
    ]);
    expect(cov.screened).toBe(2);
    expect(cov.unscreened).toEqual({ ".set": 1, ".fdt": 1, ".fif.gz": 1, ".nii.gz": 1 });
  });

  test("summaries carry counts, and shapes carry no letters or digits", () => {
    const findings = scanEdfHeader(buildHeader({ patient: "alice F 14-MAR-1993 alice" }));
    expect(countByKind(findings)).toEqual({
      "edf-patient-code": 1,
      "edf-patient-name": 1,
      "edf-patient-birthdate": 1,
    });
    expect(shapeOf("Alice 14-MAR-1993")).toBe("Aa+ 99-A+-9+" as Shape);
    for (const f of findings) expect(f.shape).toMatch(/^[aA9+\-_ .=]*$/);
  });
});

describe("a finding never carries a value (non-ASCII, ancestors, arrays)", () => {
  const safeShape = /^[aA9 !-/:-@[-`{-~?+]*$/;

  test("shapeOf maps letters of any script to a or A and every other non-ASCII character to ?", () => {
    expect(shapeOf("Jos\u00e9")).toBe("Aa+" as Shape);
    expect(shapeOf("\u5f20\u4f1f")).toBe("aa" as Shape);
    expect(shapeOf("\u0418\u0432\u0430\u043d")).toBe("Aa+" as Shape);
    expect(shapeOf("a\u0301")).toBe("a?" as Shape);
    expect(shapeOf("\u0001\u007f")).toBe("??" as Shape);
    expect(shapeOf("")).toBe("" as Shape);
  });

  test("a CJK or accented value under an identifier key leaves no letter behind", () => {
    const found = scanJsonKeys({ PatientName: "\u5f20\u4f1f", Contact: "Jos\u00e9 Garc\u00eda" });
    expect(found.length).toBe(2);
    for (const f of found) expect(f.shape).toMatch(safeShape);
    expect(JSON.stringify(found)).not.toContain("\u5f20");
    expect(JSON.stringify(found)).not.toContain("Garc");
  });

  test("a path with a non-ASCII image name reports a shape, not the name", () => {
    const found = scanPaths(["sourcedata/\u5f20\u4f1f.jpg"]);
    expect(found.map((f) => f.kind)).toEqual(["image-or-document-file"]);
    expect(JSON.stringify(found)).not.toContain("\u5f20");
  });

  test("only the matched key is reported; an ancestor key that is a name never enters a finding", () => {
    const found = scanJsonKeys({
      janedoe: { PatientName: "x" },
      rows: [{ smithfamily: { dob: "1990" } }],
    });
    expect(found.map((f) => f.field).sort()).toEqual(["dob", "patientname"]);
    expect(JSON.stringify(found)).not.toContain("janedoe");
    expect(JSON.stringify(found)).not.toContain("smithfamily");
  });

  test("identifier keys holding arrays or objects are flagged; empty containers are not", () => {
    expect(scanJsonKeys({ PatientName: ["dan"] }).map((f) => f.kind)).toEqual([
      "json-identifier-key",
    ]);
    expect(scanJsonKeys({ BirthDate: { y: "1990" } }).map((f) => f.kind)).toEqual([
      "json-identifier-key",
    ]);
    expect(scanJsonKeys({ PatientName: [], BirthDate: {}, Contact: [""] })).toEqual([]);
  });

  test("a non-ASCII byte in the patient field is a finding, whatever it spells", () => {
    const latin1 = buildHeader({ patient: "S_01 F X Jos\u00e9" });
    expect(kinds(latin1)).toContain("edf-patient-nonascii");
    const utf8 = buildHeader();
    utf8.set([0xe5, 0xbc, 0xa0, 0xe4, 0xbc, 0x9f], 8); // a two-character CJK name as UTF-8 bytes
    const found = scanEdfHeader(utf8);
    expect(found.map((f) => f.kind)).toContain("edf-patient-nonascii");
    for (const f of found) expect(f.shape).toMatch(safeShape);
    expect(kinds(buildHeader({ patient: "S_01 F X X" }))).not.toContain("edf-patient-nonascii");
  });

  test("a non-ASCII byte in the recording field is a review finding", () => {
    const bytes = buildHeader();
    bytes.set([0xc3, 0xa9], 100);
    expect(scanEdfHeader(bytes).find((f) => f.kind === "edf-recording-nonascii")?.severity).toBe(
      "review",
    );
  });
});

describe("header rules: names fused to digits, extras, dates, descriptive words", () => {
  test("a name fused to digits is a name; a study code is not", () => {
    expect(kinds(buildHeader({ patient: "alice7 F 01-JAN-1990 X_X" }))).toEqual([
      "edf-patient-code",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 F 01-JAN-1990 john3" }))).toEqual([
      "edf-patient-name",
    ]);
    expect(kinds(buildHeader({ patient: "S01 F 01-JAN-1990 P7" }))).toEqual([]);
  });

  test("a two-letter name is caught, and a neutral hyphenated phrase is not", () => {
    expect(kinds(buildHeader({ patient: "S_01 F X Li" }))).toEqual(["edf-patient-name"]);
    expect(kinds(buildHeader({ patient: "sub-01 right-handed years anonymized" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 F X Unnamed" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 F X HC" }))).toEqual([]);
  });

  test("additional subfields: key=value metadata is clean, a bare name is not", () => {
    expect(kinds(buildHeader({ patient: "S_01 M X X hand=1 weight=71.5 height=180" }))).toEqual([]);
    expect(kinds(buildHeader({ patient: "S_01 M X X hand=1 Smith" }))).toEqual([
      "edf-patient-freetext",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 M X X 14-MAR-1993" }))).toEqual([
      "edf-patient-birthdate",
    ]);
  });

  test("birth dates in ISO, US, European and compact layouts are judged the same way", () => {
    const flagged = ["1993-03-14", "03/14/1993", "14.03.1993", "19930314", "02/01/1993"];
    for (const date of flagged) {
      expect(kinds(buildHeader({ patient: `S_01 M ${date} X_X` }))).toEqual([
        "edf-patient-birthdate",
      ]);
    }
    const yearOnly = ["1993-01-01", "01/01/1993", "01.01.1993", "19930101"];
    for (const date of yearOnly) {
      expect(kinds(buildHeader({ patient: `S_01 M ${date} X_X` }))).toEqual([]);
    }
  });

  test("an impossible date in the birth slot is not shown to be clean, so it is reported", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 31/31/1993 X_X" }))).toEqual([
      "edf-patient-birthdate",
    ]);
    expect(kinds(buildHeader({ patient: "S_01 M X X_X" }))).toEqual([]);
  });

  test("a three-token field is read as free text, not as a short structured field", () => {
    expect(kinds(buildHeader({ patient: "S_01 M 14-MAR-1993" }))).toEqual([
      "edf-patient-birthdate",
    ]);
    expect(kinds(buildHeader({ patient: "X X 01-JAN-1993" }))).toEqual([]);
  });

  test("a lowercase X in the sex position still makes the field structured", () => {
    expect(kinds(buildHeader({ patient: "alice x X alice" })).sort()).toEqual([
      "edf-patient-code",
      "edf-patient-name",
    ]);
  });

  test("the BDF magic must start with 0xFF; the same bytes with another first byte are unreadable", () => {
    const ok = buildHeader({ family: "bdf" });
    expect(detectEdfFamily(ok)).toBe("bdf");
    const bad = buildHeader({ family: "bdf" });
    bad[0] = 0x41;
    expect(detectEdfFamily(bad)).toBeNull();
    expect(kinds(bad)).toEqual(["edf-unreadable"]);
  });

  test("a patient field filling all 80 bytes is read in full", () => {
    const patient = `S_01 F 01-JAN-1990 ${"n".repeat(80 - "S_01 F 01-JAN-1990 ".length)}`;
    expect(patient.length).toBe(80);
    expect(kinds(buildHeader({ patient }))).toEqual(["edf-patient-name"]);
  });

  test("recording dates: lowercase keyword, bare date, ISO date and year-only are judged correctly", () => {
    expect(kinds(buildHeader({ recording: "startdate 14-MAR-2023 X X X" }))).toEqual([
      "edf-recording-startdate",
    ]);
    expect(kinds(buildHeader({ recording: "2023-03-14 session" }))).toEqual([
      "edf-recording-startdate",
    ]);
    expect(kinds(buildHeader({ recording: "Startdate 01-JAN-2023 X X X" }))).toEqual([]);
    expect(kinds(buildHeader({ recording: "Startdate notadate X X X" }))).toEqual([
      "edf-recording-freetext",
    ]);
  });

  test("an admin code or equipment string that reads as a name is a review finding", () => {
    const found = scanEdfHeader(buildHeader({ recording: "Startdate X Marlowe X X" }));
    expect(found.map((f) => [f.kind, f.severity])).toEqual([["edf-recording-freetext", "review"]]);
  });
});

describe("participant labels and local paths", () => {
  test("a name-like sub- label in a path or a participants table is a review finding", () => {
    expect(scanPaths(["sub-johnny/eeg/x.edf"]).map((f) => f.kind)).toEqual(["path-subject-label"]);
    expect(
      scanPaths(["sub-01/eeg/x.edf", "sub-control/eeg/x.edf", "sub-NDARINV123/x.edf"]),
    ).toEqual([]);
    const table = "participant_id\tage\nsub-johnny\t20\nsub-01\t21\nsub-control\t22\n";
    const found = scanParticipantIds(table);
    expect(found.map((f) => f.kind)).toEqual(["path-subject-label"]);
    expect(JSON.stringify(found)).not.toContain("johnny");
    expect(scanParticipantIds("participant_id\tage\nsub-01\t21\n")).toEqual([]);
  });

  test("a home path inside a URL, and a generic account, are not a local user path", () => {
    expect(scanTextForLocalPaths("see https://example.org/home/page for details")).toEqual([]);
    expect(scanTextForLocalPaths("cd /home/user/project")).toEqual([]);
    expect(scanTextForLocalPaths("C:\\Users\\runner\\work")).toEqual([]);
    expect(scanTextForLocalPaths("cd /home/erin/project").length).toBe(1);
    expect(scanTextForLocalPaths("x = '/Users/dana/data.csv'").length).toBe(1);
  });

  test("a real account later in a text is found after a generic one", () => {
    for (const text of [
      "cd /home/user/project then open /Users/erin/data.csv",
      "C:\\Users\\runner\\work then C:\\Users\\dana\\data.csv",
      "C:\\\\Users\\\\you\\\\x then C:\\\\Users\\\\dana\\\\data.csv",
      "/home/user/x then C:\\Users\\erin\\y",
      "C:\\Users\\runner\\x then /home/erin/y",
      "/home/Runner/x and /home/erin/y",
    ]) {
      const found = scanTextForLocalPaths(text);
      expect(found.map((f) => f.kind)).toEqual(["local-user-path"]);
      expect(found[0]?.severity).toBe("review");
      expect(found[0]?.field).toBe("text");
      expect(JSON.stringify(found)).not.toMatch(/erin|dana/);
    }
    // The shape is that of the real account's path, not of the generic one before it.
    const [finding] = scanTextForLocalPaths("cd /home/user/project then open /Users/erin/data.csv");
    expect(finding?.shape).toBe(shapeOf("/Users/erin"));
    expect(finding?.shape).not.toBe(shapeOf("/home/user"));
  });

  test("many generic accounts before a real one do not hide it", () => {
    const generic = ["user", "you", "runner", "ubuntu", "root", "docker", "default", "shared"];
    const text = [
      ...generic.map((a) => `/home/${a}/work`),
      ...generic.map((a) => `C:\\Users\\${a}\\work`),
      "/Users/erin/data.csv",
    ].join(" ; ");
    expect(scanTextForLocalPaths(text).map((f) => f.kind)).toEqual(["local-user-path"]);
    // Dropping the real account leaves nothing to find: the finding is not from the generic ones.
    expect(
      scanTextForLocalPaths(text.replace("/Users/erin/data.csv", "relative/data.csv")),
    ).toEqual([]);
  });

  test("a text of only generic accounts has no finding, however many there are", () => {
    const text = [
      "cd /home/user/project",
      "C:\\Users\\runner\\work",
      "/Users/you/x",
      "/home/ubuntu/y",
      "C:\\\\Users\\\\vagrant\\\\z",
    ].join("\n");
    expect(scanTextForLocalPaths(text)).toEqual([]);
  });

  test("a text with several real accounts still yields one finding", () => {
    const found = scanTextForLocalPaths("/Users/erin/a then /home/dana/b then C:\\Users\\fay\\c");
    expect(found.map((f) => f.kind)).toEqual(["local-user-path"]);
  });

  test("a home path inside a URL stays excluded in a text with several paths", () => {
    expect(
      scanTextForLocalPaths("see https://example.org/home/erin/page and cd /home/user/project"),
    ).toEqual([]);
    expect(
      scanTextForLocalPaths("cd /home/user/x ; see https://example.org/Users/dana/page"),
    ).toEqual([]);
    expect(
      scanTextForLocalPaths("https://a.example/home/erin/p https://b.example/Users/dana/q"),
    ).toEqual([]);
    // A real path after the URLs is still found, and its shape is the real path's, not the URL's.
    const [finding] = scanTextForLocalPaths(
      "see https://example.org/home/erin/page and open /Users/dana/data.csv",
    );
    expect(finding?.kind).toBe("local-user-path");
    expect(finding?.shape).toBe(shapeOf("/Users/dana"));
  });

  test("repeated calls on the same text give the same answer", () => {
    const texts = [
      "cd /home/user/project then open /Users/erin/data.csv",
      "cd /home/user/project",
      "C:\\Users\\runner\\work then C:\\Users\\dana\\data.csv",
      "see https://example.org/home/erin/page",
      "/Users/erin/work/x.py",
      "relative/path/x.py",
    ];
    const first = texts.map((t) => scanTextForLocalPaths(t));
    for (let round = 0; round < 3; round++) {
      // Forwards, then backwards, so no call can depend on where an earlier one stopped.
      expect(texts.map((t) => scanTextForLocalPaths(t))).toEqual(first);
      expect([...texts].reverse().map((t) => scanTextForLocalPaths(t))).toEqual(
        [...first].reverse(),
      );
    }
    expect(first.map((f) => f.length)).toEqual([1, 0, 1, 0, 1, 0]);
  });
});

describe("headers written by an independent EDF+ writer (edfio)", () => {
  const read = (name: string) =>
    new Uint8Array(
      readFileSync(join(import.meta.dir, "fixtures/identifier-scan", name)).subarray(
        0,
        EDF_HEADER_BYTES,
      ),
    );

  test("an EDF+ header with a name, birth date, acquisition date and operator is flagged field by field", () => {
    const found = scanEdfHeader(read("flagged.edf"));
    expect(found.map((f) => f.kind).sort()).toEqual([
      "edf-patient-birthdate",
      "edf-patient-name",
      "edf-recording-startdate",
      "edf-recording-technician",
      "edf-startdate",
    ]);
    expect(JSON.stringify(found).toLowerCase()).not.toContain("fixturename");
    expect(JSON.stringify(found)).not.toContain("Opname");
  });

  test("the clean twin written by the same tool has no findings", () => {
    expect(scanEdfHeader(read("clean.edf"))).toEqual([]);
  });
});

describe("second review: delimiters, record numbers, slots, coverage, canonical fields", () => {
  const birth = (patient: string) => kinds(buildHeader({ patient }));

  test("a birth date next to a delimiter, or in a compact or spaced layout, is still found", () => {
    const flagged = [
      "P01 F dob=14.03.1993 X",
      "P01 F DOB:19930314 X",
      "P01 F *14.03.1993 X",
      "P01 M 14.03.1993. X_X",
      "P01 M 14.03.1993, X_X",
      "P01 F (14.03.1993) X",
      "P01 F 14MAR1993 X",
      "P01 F 14 03 1993 X",
      "P01 F 14031993 X",
    ];
    for (const patient of flagged) {
      expect(birth(patient), patient.replace(/\d/g, "9")).toContain("edf-patient-birthdate");
    }
    const yearOnly = [
      "P01 F dob=01.01.1993 X",
      "P01 F (01.01.1993) X",
      "P01 F 01JAN1993 X",
      "P01 F 01011993 X",
    ];
    for (const patient of yearOnly) {
      expect(birth(patient), patient.replace(/\d/g, "9")).not.toContain("edf-patient-birthdate");
    }
  });

  test("a birth date is reported once however many places it appears", () => {
    const found = scanEdfHeader(buildHeader({ patient: "P01 F 14.03.1993 dob=14.03.1993" }));
    expect(found.filter((f) => f.kind === "edf-patient-birthdate").length).toBe(1);
  });

  test("short names joined by a delimiter are names; neutral words joined by one are not", () => {
    for (const name of ["Lee^Kim", "Li,Wu", "Li/Wu", "Wu:Li"]) {
      expect(birth(`S_01 F X ${name}`), name).toContain("edf-patient-name");
    }
    for (const word of ["right/left", "hand=1", "age=25", "kg=70/cm=180"]) {
      expect(birth(`S_01 F X X ${word}`), word).toEqual([]);
    }
  });

  test("a number that could be a record number is a review finding, never a direct one", () => {
    for (const code of ["1234567", "MRN1234567", "A1234567", "555-12-3456"]) {
      const found = scanEdfHeader(buildHeader({ patient: `${code} F X X` }));
      const number = found.find((f) => f.kind === "edf-patient-recordnumber");
      expect(number?.severity, code.replace(/\d/g, "9")).toBe("review");
      expect(JSON.stringify(found)).not.toContain(code);
    }
    expect(birth("S_01 F X X age=25")).toEqual([]);
    expect(birth("01 M 25 X")).toEqual([]);
    expect(birth("S_01 F 14031993 X")).not.toContain("edf-patient-recordnumber");
  });

  test("an unparsable header start date is reported, and is not an acquisition date", () => {
    for (const startdate of ["03/14/20", "2020-03-", "Smithson", "12345678", "31.31.99"]) {
      const found = kinds(buildHeader({ startdate }));
      expect(found, startdate).toEqual(["edf-startdate-unparsed"]);
      expect(DATE_KINDS.has("edf-startdate-unparsed")).toBe(false);
    }
    expect(kinds(buildHeader({ startdate: "14.03.93" }))).toEqual(["edf-startdate"]);
    expect(kinds(buildHeader({ startdate: "01.01.93" }))).toEqual([]);
  });

  test("text or a number in the recording date slot is not a date and is not a DATE kind", () => {
    for (const slot of ["JohnSmith", "4417823"]) {
      const found = kinds(buildHeader({ recording: `Startdate ${slot} X X X` }));
      expect(found, slot.replace(/\d/g, "9")).toEqual(["edf-recording-freetext"]);
      expect(found.some((k) => DATE_KINDS.has(k))).toBe(false);
    }
  });

  test("a classic free-text recording identification with a name is a direct finding; neutral text is not", () => {
    const named = scanEdfHeader(buildHeader({ recording: "Hospital recording of Alice Smith" }));
    const finding = named.find((f) => f.kind === "edf-recording-freetext");
    expect(finding?.severity).toBe("identifier");
    expect(DIRECT_KINDS.has("edf-recording-freetext")).toBe(true);
    expect(JSON.stringify(named).toLowerCase()).not.toContain("alice");
    expect(kinds(buildHeader({ recording: "resting eeg session 14 MAR 1993" }))).toEqual([
      "edf-recording-startdate",
    ]);
  });

  test("an acquisition date in a scans table is a DATE kind, like a header date", () => {
    const found = scanAcqTime("2023-03-14T10:00:00");
    expect(found.map((f) => f.kind)).toEqual(["acq-time-dated"]);
    expect(DATE_KINDS.has("acq-time-dated")).toBe(true);
  });

  test("reported field names are canonical spellings from a closed set", () => {
    const found = scanJsonKeys({
      Patient_Name: "x",
      "Medical Record No": "y",
      PatientBirthDate: "z",
    });
    expect(found.map((f) => f.field).sort()).toEqual([
      "medicalrecordno",
      "patientbirthdate",
      "patientname",
    ]);
    const columns = scanTableColumns(
      "participant_id\tparticipant_name\tSubject Name\tfamily_name\tforename\tpatient_code\thospital_id",
    );
    expect(columns.map((f) => f.field)).toEqual([
      "participantname",
      "subjectname",
      "familyname",
      "forename",
      "patientcode",
      "hospitalid",
    ]);
  });

  test("a name-like sub- label in any script is a review finding", () => {
    const found = scanPaths([
      "sub-M\u00fcller/eeg/x.edf",
      "sub-\u5f20\u4f1f\u660e\u534e/eeg/y.edf",
    ]);
    expect(found.map((f) => f.kind)).toEqual(["path-subject-label", "path-subject-label"]);
    expect(JSON.stringify(found)).not.toContain("ller");
  });

  test("coverage counts recording data in any format the module cannot read", () => {
    const cases: [string[], Record<string, number>][] = [
      [
        ["sub-01/meg/sub-01_task-x_meg.ds/a.meg4", "sub-01/meg/sub-01_task-x_meg.ds/a.res4"],
        { ".ds/": 1 },
      ],
      [["sub-01/emg/sub-01_task-x_emg.hdf5"], { ".hdf5": 1 }],
      [["sub-01/eeg/sub-01_task-x_eeg.edf.gz"], { ".edf.gz": 1 }],
      [["sub-01/eeg/sub-01_task-x_eeg.eeg", "sub-01/eeg/sub-01_task-x_eeg.json"], { ".eeg": 1 }],
      [["sub-01/eeg/a.mff/info.xml", "sub-01/eeg/a.mff/signal1.bin"], { ".mff/": 1 }],
      [["sub-01/ieeg/a.mefd/x/y.timd"], { ".mefd/": 1 }],
      [["sub-01/eeg/a.zarr/.zarray", "sub-01/eeg/b.zarr/.zarray"], { ".zarr/": 2 }],
      [["sourcedata/a.mat", "sourcedata/b.mat"], { ".mat": 2 }],
    ];
    for (const [paths, expected] of cases) {
      expect(formatCoverage(paths).unscreened, paths[0]).toEqual(expected);
    }
    expect(formatCoverage(["sub-01/eeg/a.edf", "sub-01/eeg/a.json", "sub-01/eeg/a.tsv"])).toEqual({
      screened: 1,
      unscreened: {},
    });
    expect(
      formatCoverage(["sub-01/eeg/sub-01_task-x_eeg.json", "sub-01/eeg/sub-01_task-x_events.tsv"])
        .unscreened,
    ).toEqual({});
  });
});

describe("third review: birth dates in the recording field, slots, vocabulary, ages, coverage", () => {
  const rec = (recording: string) => scanEdfHeader(buildHeader({ recording }));
  const recKinds = (recording: string) => rec(recording).map((f) => f.kind);
  const sev = (recording: string, kind: string) =>
    rec(recording).find((f) => f.kind === kind)?.severity;
  const pat = (patient: string) => kinds(buildHeader({ patient }));

  test("a birth date in the recording field is a direct finding, never an acquisition date", () => {
    for (const recording of [
      "DOB 14.03.1993",
      "Startdate X X X X 14-MAR-1993",
      "Startdate 14-MAR-2020 X X X dob=14-MAR-1993",
      "Startdate 14-MAR-2020 DOB:19930314 X X",
    ]) {
      expect(sev(recording, "edf-patient-birthdate"), recording.replace(/\d/g, "9")).toBe(
        "identifier",
      );
    }
    expect(recKinds("Startdate 14-MAR-2020 DOB:19930314 X X").sort()).toEqual([
      "edf-patient-birthdate",
      "edf-recording-startdate",
    ]);
    expect(JSON.stringify(rec("DOB 14.03.1993"))).not.toContain("1993");
  });

  test("an ordinary date in the recording field stays an acquisition date", () => {
    expect(recKinds("Startdate 14-MAR-2020 X X X")).toEqual(["edf-recording-startdate"]);
    expect(recKinds("session 14 MAR 2020")).toEqual(["edf-recording-startdate"]);
    expect(recKinds("Startdate 01-JAN-2020 X X X")).toEqual([]);
  });

  test("the birth slot accepts placeholders, a bare year and an age, and reports anything else", () => {
    for (const slot of [
      "NA",
      "unknown",
      "n/a",
      "-",
      "x",
      "X",
      "1993",
      "34y",
      "34",
      "01-JAN-1993",
    ]) {
      expect(pat(`S1 M ${slot} X`), slot).toEqual([]);
    }
    expect(pat("S1 M foo123 X")).toEqual(["edf-patient-birthdate"]);
    expect(pat("S1 M 14-MAR-1993 X")).toEqual(["edf-patient-birthdate"]);
  });

  test("small numbers separated by spaces are not dates, but a four-digit year makes one", () => {
    expect(pat("Subject 01 02 03")).toEqual([]);
    expect(pat("S1 M X X 12 11 10")).toEqual([]);
    expect(pat("S1 M X X 12 11 2010")).toEqual(["edf-patient-birthdate"]);
    expect(pat("S1 M X X 14.03.199345")).not.toContain("edf-patient-birthdate");
  });

  test("underscores, year-month and month-name forms count as dates", () => {
    for (const date of ["14_03_1993", "1993-03", "MAR-1993", "Mar 1993", "1993_03_14"]) {
      expect(pat(`P01 F ${date} X`), date.replace(/\d/g, "9")).toContain("edf-patient-birthdate");
    }
    expect(pat("P01 F 01_01_1993 X")).toEqual([]);
  });

  test("ordinary recording vocabulary is not a name", () => {
    for (const recording of [
      "Resting state EEG",
      "Eyes closed",
      "BrainVision Recorder",
      "baseline of the study at lab",
    ]) {
      expect(recKinds(recording), recording).toEqual([]);
    }
    expect(recKinds("Recorded by Marlowe")).toContain("edf-recording-freetext");
  });

  test("an age over 89 is an identifier wherever it is written; 89 and an age in range are not", () => {
    for (const patient of [
      "P01 M 95 X",
      "S1 M X X age=95",
      "S1 M X X 95y",
      "age 100",
      "P01 M 130 X",
      "S1 M X X age: 92",
    ]) {
      expect(pat(patient), patient).toContain("edf-patient-age");
    }
    for (const patient of ["S1 M 89 X", "S1 M X X age=25", "S1 M X X 89y", "S1 M 131 X"]) {
      expect(pat(patient), patient).not.toContain("edf-patient-age");
    }
    const finding = scanEdfHeader(buildHeader({ patient: "S1 M X X age=95" })).find(
      (f) => f.kind === "edf-patient-age",
    );
    expect(finding?.severity).toBe("identifier");
    expect(DIRECT_KINDS.has("edf-patient-age")).toBe(true);
  });

  test("coverage counts archives, vendor-native files and unrecognized raw files under sourcedata", () => {
    const counted = (paths: string[]) => formatCoverage(paths).unscreened;
    expect(counted(["sourcedata/raw.zip"])).toEqual({ ".zip": 1 });
    expect(counted(["sourcedata/raw.tar.gz"])).toEqual({ ".tar.gz": 1 });
    for (const ext of ["ns5", "lay", "rec", "smr", "dat", "npy", "parquet"]) {
      expect(counted([`data/recording.${ext}`]), ext).toEqual({ [`.${ext}`]: 1 });
    }
    expect(counted(["data/raw.hdf5"])).toEqual({ ".hdf5": 1 });
    expect(counted(["sourcedata/sub-01/rec.xyz"])).toEqual({ ".xyz": 1 });
    expect(counted(["sourcedata/sub-01/rec"])).toEqual({ "(no extension)": 1 });
    expect(
      counted([
        "sourcedata/README.md",
        "sourcedata/x.json",
        "sourcedata/code/run.py",
        "sourcedata/LICENSE",
        "sourcedata/CHANGES",
        "sourcedata/a.jpg",
      ]),
    ).toEqual({});
    expect(counted(["code/run.xyz"])).toEqual({});
  });
});

describe("fourth review: birth words, strict slots, ages, month names, harmless files", () => {
  const rec = (recording: string) => scanEdfHeader(buildHeader({ recording }));
  const recKinds = (recording: string) => rec(recording).map((f) => f.kind);
  const pat = (patient: string) => kinds(buildHeader({ patient }));

  test("a birth word anywhere in a free-text recording id makes its dates birth dates", () => {
    for (const recording of [
      "birthdate 14.03.1993",
      "birth_date=14.03.1993",
      "*14.03.1993 dob",
      "DOB (dd.mm.yyyy): 14.03.1993",
      "Date of Birth (dd.mm.yyyy): 14.03.1993",
      "born on 14.03.1993",
      "Geboren 14.03.1993",
    ]) {
      expect(recKinds(recording), recording.replace(/\d/g, "9")).toContain("edf-patient-birthdate");
      expect(recKinds(recording)).not.toContain("edf-recording-startdate");
    }
    expect(recKinds("birthdate 01.01.1993")).toEqual([]);
    expect(recKinds("session 14 MAR 2020")).toEqual(["edf-recording-startdate"]);
  });

  test("a patient code or name slot exempts placeholders only, not ordinary words that are also surnames", () => {
    for (const word of ["Day", "To", "In", "Sham", "Block", "Raw", "Open"]) {
      expect(pat(`P01 F X ${word}`), word).toEqual(["edf-patient-name"]);
      expect(pat(`${word} F X X`), word).toEqual(["edf-patient-code"]);
    }
    for (const word of ["Unknown", "Unnamed", "HC", "NN", "X", "anonymized"]) {
      expect(pat(`P01 F X ${word}`), word).toEqual([]);
    }
    // The same words are fine as additional subfields, which are free text.
    expect(pat("P01 F X X Day")).toEqual([]);
  });

  test("ages over 89 in every spelling, and none for the spurious ones", () => {
    for (const patient of [
      "M 95",
      "F 93",
      "S1 M X X 95yo",
      "S1 M X X 95-year-old",
      "P01 M 1930 X",
      "P01 M 01-JAN-1930 X",
    ]) {
      expect(pat(patient), patient).toContain("edf-patient-age");
    }
    for (const patient of [
      "P01 M 5-MAY-95 X",
      "P01 M 1-MAY-95 X",
      "P01 M 1993 X",
      "M 45",
      "S1 M X X 89yo",
    ]) {
      expect(pat(patient), patient).not.toContain("edf-patient-age");
    }
  });

  test("month-first year-month forms are dates; words that merely start like a month are not", () => {
    for (const patient of [
      "P01 F 03/1993 X",
      "P01 F 03.1993 X",
      "P01 F dob 03/1993 X",
      "P01 F sept 1993 X",
    ]) {
      expect(pat(patient), patient).toContain("edf-patient-birthdate");
    }
    expect(recKinds("Startdate X X X X 03/1993")).toContain("edf-patient-birthdate");
    for (const word of [
      "Marker 2020",
      "Mayo 1993",
      "Julia 1993",
      "Decay 2019",
      "S01_2020_03",
      "S01-2012",
    ]) {
      expect(pat(`P01 F X X ${word}`), word).not.toContain("edf-patient-birthdate");
    }
  });

  test("documentation and housekeeping files under sourcedata are not unscreened data", () => {
    const counted = (paths: string[]) => formatCoverage(paths).unscreened;
    expect(
      counted([
        "sourcedata/README",
        "sourcedata/.DS_Store",
        "sourcedata/.gitkeep",
        "sourcedata/Thumbs.db",
        "sourcedata/x.docx",
        "sourcedata/y.xlsx",
        "sourcedata/z.html",
        "sourcedata/a.log",
      ]),
    ).toEqual({});
    expect(counted(["data/archive.zip"])).toEqual({ ".zip": 1 });
  });
});

describe("fifth pass: group words, localized months, asterisk, units, survivors", () => {
  const pat = (patient: string) => kinds(buildHeader({ patient }));
  const recKinds = (recording: string) => kinds(buildHeader({ recording }));

  test("study-design words are codes in a code slot, but surname-like words still are not", () => {
    for (const code of ["Control_01", "Healthy_05", "Test01", "Pilot_03", "Phantom", "Study1"]) {
      expect(pat(`${code} F X X`), code).toEqual([]);
    }
    expect(pat("Day F X X")).toEqual(["edf-patient-code"]);
    expect(pat("Open_01 F X X")).toEqual(["edf-patient-code"]);
  });

  test("a date written with a non-English month is still a date, in both fields", () => {
    for (const date of [
      "14.Okt.1993",
      "14-Dez-1993",
      "14-Mai-1993",
      "14-Avr-1993",
      "14-Ene-1993",
    ]) {
      expect(pat(`P01 F ${date} X`), date.replace(/\d/g, "9")).toContain("edf-patient-birthdate");
    }
    expect(recKinds("session 14-Dez-2020")).toEqual(["edf-recording-startdate"]);
    expect(pat("P01 F X X Marker 2020")).not.toContain("edf-patient-birthdate");
  });

  test("a leading asterisk marks a birth date in a free-text recording id, and `born` is a whole word", () => {
    expect(recKinds("*14.03.1993")).toContain("edf-patient-birthdate");
    expect(recKinds("*14.03.1993")).not.toContain("edf-recording-startdate");
    expect(recKinds("Osborne 14.03.2020")).not.toContain("edf-patient-birthdate");
    expect(recKinds("nacimiento 14.03.1993")).toContain("edf-patient-birthdate");
  });

  test("a number followed by a unit is not an age", () => {
    for (const patient of ["M 95 kg", "F 100 cm", "M 95 bpm"]) {
      expect(pat(patient), patient).not.toContain("edf-patient-age");
    }
    expect(pat("M 95")).toContain("edf-patient-age");
    expect(pat("M 95 years")).toContain("edf-patient-age");
  });

  test("the age slot works on its own, and Sept is a month", () => {
    expect(pat("P01 X 95 X")).toContain("edf-patient-age");
    expect(pat("dob sept 1993")).toContain("edf-patient-birthdate");
    expect(pat("dob september 1993")).toContain("edf-patient-birthdate");
  });
});

describe("a birth date is reported once per field", () => {
  test("a birth date in the patient field does not hide one in the recording field", () => {
    const found = scanEdfHeader(
      buildHeader({ patient: "P01 F 14-MAR-1993 X", recording: "Startdate X X X dob=14.03.1993" }),
    ).filter((f) => f.kind === "edf-patient-birthdate");
    expect(found.map((f) => f.field).sort()).toEqual(["patient.birthdate", "recording.birthdate"]);
  });

  test("two birth dates in one field are one finding", () => {
    const found = scanEdfHeader(
      buildHeader({ patient: "P01 F 14-MAR-1993 dob=14.03.1993" }),
    ).filter((f) => f.kind === "edf-patient-birthdate");
    expect(found.length).toBe(1);
  });
});
