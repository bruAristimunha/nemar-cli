/**
 * Every `docs.nemar.org` page URL this repo points at must be a page that
 * exists (epic #1336 phase 1, issue #1339, ADR 0057).
 *
 * ADR 0057 makes the docs site the canonical retrieval surface and takes
 * repository access out of the retrieval contract. From here on, `AGENTS.md`
 * and `.rules/*` stop describing things and start POINTING at them, so a
 * pointer that resolves to nothing is not a cosmetic problem: it is the
 * reference material being unreachable for the agent that was told to read it.
 *
 * `starlight-links-validator` already fails the docs build on a broken
 * internal link. This is the other direction, and nothing covered it. Note
 * that the docs plugin also would not catch this even inside its own repo: it
 * defaults to `sameSitePolicy: 'ignore'`, so an absolute
 * `https://docs.nemar.org/...` link is invisible to it.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS AND BOTH WERE LEARNED THE HARD WAY.
 *
 * **Resolution is a slug map, not path arithmetic.** `slug:` frontmatter
 * decouples the source path from the published URL in both directions. Today
 * `src/content/docs/platform/zarr.md` declares `slug: platform/zarr/mental-model`
 * while `/platform/zarr/` is served by `platform/zarr/index.md`, so guessing
 * candidate paths both falsely passes `/platform/zarr/` and falsely fails
 * `/platform/zarr/mental-model/`. The docs repo's own
 * `scripts/check-admin-gating.ts` carries the same warning.
 *
 * **The comparison reads a git ref, never the working tree.** Two exploration
 * passes over the sibling checkout disagreed about whether any page uses
 * `slug:` at all, because one read a working tree parked on a feature branch
 * that was missing twenty-odd pages. A checker whose answer depends on which
 * branch someone left checked out reports drift that is not there, and the
 * blame lands on the checker.
 *
 * That narrows the failure mode rather than removing it: a stale local `main`
 * is the same skew one level removed, so `origin/main` is preferred over
 * `main`. On a developer machine with an unfetched clone the answer can still
 * be stale, and only CI, which checks out fresh, is authoritative.
 *
 * Real filesystem and real git, no mocks. `.rules/testing.md`: prove the test
 * fails.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Set by CI to the checkout it made. A relative value resolves against the
 *  repo root, which is the workflow's working directory. */
const DOCS_ENV_VAR = "NEMAR_DOCS_CHECKOUT";
const declaredRaw = process.env[DOCS_ENV_VAR];
const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;

/**
 * Where a docs checkout is expected to sit relative to this one.
 *
 * Both repos live under one parent directory, and this repo is often a
 * WORKTREE (`phase1-inventory/`, `epic-agent-docs/`, ...) rather than
 * `nemar-cli/` itself, so the sibling can be one or two levels up.
 * Only consulted when {@link DOCS_ENV_VAR} is unset.
 */
const DOCS_CANDIDATES = [join(REPO_ROOT, "..", "docs"), join(REPO_ROOT, "..", "..", "docs")];

/**
 * Every tracked file that mentions the docs host, found by asking git rather
 * than by listing directories.
 *
 * An allowlist of paths was the first design and it was wrong in both
 * directions: it missed `README.md`'s four pointers until review caught it, and
 * it missed the ones that matter most, which are not in markdown at all --
 * `SUBMISSION_POLICY_URL` in `shared/submission-minimums.ts` and
 * `CONTRIBUTOR_TERMS_URL` in `src/lib/attestation.ts` are quoted to users in
 * refusals. A grep over tracked files covers those, covers `.context/` where
 * this epic is adding pointers, and keeps covering files nobody has written
 * yet, which is the point.
 *
 * This file is excluded: its fixtures deliberately contain a URL that must not
 * resolve, and scanning ourselves would assert that a page named
 * "definitely/not/a/page" exists.
 */
function scannedFiles(): string[] {
  const listing = git(REPO_ROOT, ["grep", "-l", "docs\\.nemar\\.org"]);
  if (listing.status !== 0) return [];
  const self = "test/docs-links.unit.test.ts";
  return listing.stdout
    .split("\n")
    .filter((rel) => rel !== "" && rel !== self)
    .map((rel) => join(REPO_ROOT, rel))
    .filter((f) => existsSync(f));
}

/** Page extensions Starlight's loader accepts. `.mdoc` needs `@astrojs/markdoc`,
 *  which the docs repo does not install. */
const PAGE_EXTENSIONS = [".md", ".mdx", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn"];

/**
 * Paths served by something other than a content-collection page. Referencing
 * one is fine and must not be reported as a broken pointer.
 */
const NON_PAGE_PREFIXES = ["/pagefind/", "/_astro/", "/figures/", "/__docs-auth/"];
const NON_PAGE_EXACT = new Set([
  "/llms.txt",
  "/404",
  "/robots.txt",
  "/favicon.svg",
  "/_routes.json",
  "/sitemap-index.xml",
  "/sitemap-0.xml",
]);

/**
 * Every `docs.nemar.org` reference in a source file, as a URL pathname.
 *
 * A BARE HOSTNAME IS NOT A POINTER. All three of today's mentions are prose
 * (`AGENTS.md` names the host in a table, `.rules/documentation.md` links the
 * site root), and failing those would be reporting on the absence of a path
 * rather than on a broken link. Anything with no path segment is dropped here
 * rather than resolved to `/`.
 *
 * An anchor or query string is dropped rather than carried into the lookup. A
 * deep link into a long page is the natural pointer form once AGENTS.md stops
 * describing and starts pointing, and `/cli/commands/#nemar-auth-login` names a
 * page that exists: resolving the whole string turned a working link red, which
 * teaches the reader that the guard is wrong.
 *
 * Trailing punctuation and Markdown emphasis are stripped because prose puts a
 * period after a URL and `**bold**` puts asterisks against it.
 */
function extractDocsPaths(source: string): string[] {
  const out: string[] = [];
  // SCHEME-LESS SPELLINGS COUNT TOO. Requiring `https?://` made a real broken
  // pointer invisible: a comment in `routes/auth-web.ts` read "points typo'd
  // users at docs.nemar.org/installation", which is not a page (the real one is
  // /cli/getting-started/installation/). The guard opened that file, extracted
  // nothing, and passed. The bare form is used deliberately in prose elsewhere,
  // so it is a spelling to support rather than one to ban.
  //
  // The `(?<![\w/.@-])` guard is what keeps `https://example.com/docs.nemar.org`
  // and an email at that domain from matching -- a path segment or address that
  // merely ends in the hostname is not a pointer to it.
  for (const m of source.matchAll(
    /(?<![\w/.@-])(?:https?:\/\/)?docs\.nemar\.org(\/[^\s)>\]"'`]*)?/g,
  )) {
    const raw = m[1];
    if (!raw) continue;
    const cleaned = raw.replace(/[#?].*$/, "").replace(/[.,;:!?*_]+$/, "");
    if (cleaned === "" || cleaned === "/") continue;
    out.push(cleaned);
  }
  return out;
}

/** The slug a content file serves at, before any `slug:` override: strip the
 *  extension, then a trailing `/index`, and treat a bare root `index` as "". */
function slugFromPath(relPath: string): string {
  let slug = relPath.replace(/^src\/content\/docs\//, "");
  for (const ext of PAGE_EXTENSIONS) {
    if (slug.endsWith(ext)) {
      slug = slug.slice(0, -ext.length);
      break;
    }
  }
  if (slug === "index") return "";
  return slug.replace(/\/index$/, "");
}

/**
 * A URL pathname reduced to the slug Starlight would route it by.
 *
 * `.md` IS STRIPPED, and that is not cosmetic. Epic #1336 phase 2 gave every
 * page a Markdown mirror at its own path plus `.md`
 * (`nemarOrg/docs`, `src/pages/[...slug].md.ts`), and those are the URLs an
 * agent is told to fetch, so they will appear in pointers here. Without this
 * line the mirror of a page that certainly exists is reported as a broken
 * pointer, which is how a guard teaches people to ignore it.
 *
 * The mirror is generated FROM the same `getCollection('docs')` entry as the
 * HTML, one for one, so a `.md` URL resolving is exactly equivalent to its page
 * resolving. `llms.txt` and `sitemap.xml` are not content pages at all and are
 * excluded before this point.
 */
function pathToSlug(pathname: string): string {
  return pathname
    .replace(/\/index\.html$/, "")
    .replace(/\.html$/, "")
    .replace(/\.md$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Run git and report the exit status alongside stdout.
 *
 * The status matters and collapsing it was a real defect: `git grep` exits 1
 * for "no match" and 2 or more for "could not run", and treating both as an
 * empty result made a broken grep look exactly like a repository with no
 * `slug:` overrides. Both consumers then went blind together -- the slug map
 * silently fell back to path-derived slugs, and the test meant to catch that
 * read the same empty result and passed.
 */
function git(repo: string, args: string[]): { status: number; stdout: string } {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (res.error) return { status: -1, stdout: "" };
  return { status: res.status ?? -1, stdout: res.stdout ?? "" };
}

/**
 * First ref that resolves, so the answer does not depend on the branch someone
 * left checked out in the sibling.
 *
 * `origin/main` FIRST. A developer's local `main` is routinely behind what the
 * docs site actually serves -- the sibling here was four commits and three
 * pages behind when this was written -- and preferring it reintroduces the
 * staleness this design exists to avoid, just one level removed. In CI the two
 * are the same commit, so the order costs nothing there.
 */
function resolveRef(repo: string): string | null {
  for (const ref of ["origin/main", "main"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0) return ref;
  }
  return null;
}

/** A `slug:` value as written in frontmatter, reduced to the slug Starlight
 *  routes by. Quotes are legal YAML and were silently kept, which made the real
 *  page vanish from the map under a key wearing quotation marks. */
function normalizeSlugValue(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * The `slug:` a page declares in its OWN frontmatter, or null.
 *
 * Scoped to the frontmatter block deliberately. A bare `^slug:` match anywhere
 * in the file also matches a fenced YAML example, and a documentation site that
 * documents Starlight frontmatter is exactly where one lives: that page would
 * then be filed under the example's slug and its real URL would report broken.
 */
function declaredSlug(source: string): string | null {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") return null;
    const m = line.match(/^slug:\s*(.+?)\s*$/);
    if (m) return normalizeSlugValue(m[1]);
  }
  return null;
}

interface PublishedSlugs {
  readonly slugs: Set<string>;
  /** Source paths that declared an override, so a test can assert the override
   *  path actually ran rather than inferring it from an empty result. */
  readonly overrides: Map<string, string>;
  /** False when git could not be consulted, which must never read as "no
   *  overrides". */
  readonly ok: boolean;
}

/** Every slug the docs site publishes at `ref`, honoring `slug:` overrides. */
function publishedSlugs(repo: string, ref: string): PublishedSlugs {
  const listing = git(repo, ["ls-tree", "-r", "--name-only", ref, "--", "src/content/docs"]);
  if (listing.status !== 0) return { slugs: new Set(), overrides: new Map(), ok: false };

  const bySource = new Map<string, string>();
  for (const rel of listing.stdout.split("\n").filter(Boolean)) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (base.startsWith("_")) continue;
    if (!PAGE_EXTENSIONS.some((ext) => rel.endsWith(ext))) continue;
    bySource.set(rel, slugFromPath(rel));
  }

  // Candidates in one call; only those few files are then read in full, so the
  // frontmatter check costs one subprocess per page that might override rather
  // than one per page.
  const candidates = git(repo, ["grep", "-l", "^slug:", ref, "--", "src/content/docs"]);
  // Exit 1 is a genuine "no page declares one". Anything else is a broken call
  // and must not be mistaken for it.
  if (candidates.status > 1 || candidates.status < 0) {
    return { slugs: new Set(bySource.values()), overrides: new Map(), ok: false };
  }

  const overrides = new Map<string, string>();
  for (const line of candidates.stdout.split("\n").filter(Boolean)) {
    const path = line.replace(/^[^:]*:/, "");
    if (!bySource.has(path)) continue;
    const blob = git(repo, ["show", `${ref}:${path}`]);
    if (blob.status !== 0) return { slugs: new Set(bySource.values()), overrides, ok: false };
    const declared = declaredSlug(blob.stdout);
    if (declared !== null) {
      overrides.set(path, declared);
      bySource.set(path, declared);
    }
  }
  return { slugs: new Set(bySource.values()), overrides, ok: true };
}

const FOUND_ROOT = DECLARED_PATH ?? DOCS_CANDIDATES.find((p) => existsSync(p)) ?? null;
const REF = FOUND_ROOT && existsSync(FOUND_ROOT) ? resolveRef(FOUND_ROOT) : null;
const NO_CHECKOUT = FOUND_ROOT === null || REF === null;

if (NO_CHECKOUT && DECLARED_PATH === null) {
  console.info(
    `[docs links] skipping: no docs checkout with a resolvable main at ${DOCS_CANDIDATES.join(" or ")}, and ${DOCS_ENV_VAR} is unset.`,
  );
}

// --------------------------------------------------------------------------
// Local-side assertions. These run whether or not a docs checkout exists, so
// something always runs and the extractor is proved on inputs everyone has.
// --------------------------------------------------------------------------

describe("the extractor", () => {
  test("takes a path-bearing URL and leaves a bare hostname alone", () => {
    const source = [
      "See https://docs.nemar.org/platform/api/ for the surface.",
      "The docs live at https://docs.nemar.org.",
      "| Docs site | `docs.nemar.org`, in `nemarOrg/docs` | - |",
    ].join("\n");
    expect(extractDocsPaths(source)).toEqual(["/platform/api/"]);
  });

  test("strips trailing prose punctuation and Markdown wrappers", () => {
    expect(extractDocsPaths("see https://docs.nemar.org/cli/commands/.")).toEqual([
      "/cli/commands/",
    ]);
    expect(extractDocsPaths("[x](https://docs.nemar.org/web/uploading/)")).toEqual([
      "/web/uploading/",
    ]);
    expect(extractDocsPaths("<https://docs.nemar.org/policies/>")).toEqual(["/policies/"]);
  });

  test("drops an anchor, which names a section of a page that exists", () => {
    // Verified red before this: `/cli/commands/#nemar-auth-login` was looked up
    // whole and reported as a broken pointer to a page that is fine. Deep links
    // into long pages are the natural form once AGENTS.md points rather than
    // describes, so this is the shape phases 2 and 5 will produce.
    expect(extractDocsPaths("https://docs.nemar.org/cli/commands/#nemar-auth-login")).toEqual([
      "/cli/commands/",
    ]);
  });

  test("drops a query string for the same reason", () => {
    expect(extractDocsPaths("https://docs.nemar.org/platform/zarr/?v=2")).toEqual([
      "/platform/zarr/",
    ]);
  });

  test("strips Markdown emphasis pressed against the URL", () => {
    expect(extractDocsPaths("**https://docs.nemar.org/cli/commands/**")).toEqual([
      "/cli/commands/",
    ]);
  });

  test("finds nothing in a file that mentions no docs URL", () => {
    expect(extractDocsPaths("nothing to see, https://example.com/docs.nemar.org")).toEqual([]);
  });
});

describe("slug derivation", () => {
  test("maps a page, a nested index, and the root", () => {
    expect(slugFromPath("src/content/docs/platform/api.md")).toBe("platform/api");
    expect(slugFromPath("src/content/docs/platform/zarr/index.md")).toBe("platform/zarr");
    expect(slugFromPath("src/content/docs/cli/index.mdx")).toBe("cli");
    expect(slugFromPath("src/content/docs/index.mdx")).toBe("");
  });

  test("reduces a URL path to the same shape, trailing slash or not", () => {
    expect(pathToSlug("/platform/api/")).toBe("platform/api");
    expect(pathToSlug("/platform/api")).toBe("platform/api");
    expect(pathToSlug("/platform/api/index.html")).toBe("platform/api");
    expect(pathToSlug("/")).toBe("");
  });
});

describe("the declared docs checkout must exist when it is declared", () => {
  // A path named by CI that is not there means the checkout step broke. A skip
  // would hand the check back to nobody, which is exactly how the account-copy
  // parity test sat green and vacuous for months.
  test.skipIf(DECLARED_PATH === null)(`${DOCS_ENV_VAR} names a directory that is present`, () => {
    expect({ [DOCS_ENV_VAR]: DECLARED_PATH, exists: existsSync(DECLARED_PATH as string) }).toEqual({
      [DOCS_ENV_VAR]: DECLARED_PATH,
      exists: true,
    });
  });

  test.skipIf(DECLARED_PATH === null)(`${DOCS_ENV_VAR} has a resolvable main`, () => {
    expect({ path: DECLARED_PATH, ref: REF }).toEqual({ path: DECLARED_PATH, ref: REF ?? "main" });
    expect(REF).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// The comparison itself.
// --------------------------------------------------------------------------

describe("the comparison must actually run when a checkout was undertaken", () => {
  // The mode this guards is real: an env var that resolves to the empty string --
  // a dropped YAML interpolation, or the checkout step deleted while the `env:`
  // line stayed -- falls through to a sibling search that finds nothing on a
  // runner, and would skip the whole comparison while the job goes green.
  //
  // It used to be keyed on `process.env.CI`, which is set in EVERY GitHub Actions
  // job, and that was too broad in two ways that both bit:
  //
  //  1. A FORK pull request. `test.yml` deliberately sets the variable to `''`
  //     there, because the docs repo is private and the checkout cannot succeed
  //     on a fork. The workflow comment says the guard must then "skip VISIBLY
  //     instead of failing on a checkout that could never have worked", and ADR
  //     0057 says losing read access must not cost someone the ability to
  //     contribute. The CI-keyed guard failed those runs instead, so an outside
  //     contributor fixing a typo got a red REQUIRED check.
  //  2. Any OTHER CI job that runs this suite without wanting docs parity.
  //     `deploy-backend.yml`'s `test-gate` is one, and it had been red on every
  //     push to dev for days, which skips `deploy-dev` -- so the backend silently
  //     stopped deploying.
  //
  // So the runtime guard now keys on what it actually depends on: a job that
  // declared a NON-EMPTY checkout path undertook to provide one, and must. A job
  // that declared nothing never undertook it. An empty value is the fork case and
  // is indistinguishable at runtime from a dropped interpolation -- which is why
  // the protection against silent disabling is the STATIC check below, on the
  // workflow file itself, rather than an inference from the environment.
  test.skipIf(DECLARED_PATH === null)("the declared docs checkout resolved", () => {
    expect({ skipped: NO_CHECKOUT, root: FOUND_ROOT, ref: REF }).toEqual({
      skipped: false,
      root: FOUND_ROOT,
      ref: REF,
    });
  });
});

describe("the workflow still wires the docs checkout", () => {
  // The guard that cannot be silently dropped, because it does not depend on the
  // environment it is trying to check. Deleting the checkout step, or the `env:`
  // line that names it, makes the runtime guard above skip everywhere and take
  // the whole comparison with it. Reading the workflow file catches that in every
  // job and on a laptop, with no checkout of anything.
  const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "test.yml");

  test("test.yml checks out the docs content tree", () => {
    const yaml = readFileSync(WORKFLOW, "utf8");
    expect(yaml).toContain("repository: nemarOrg/docs");
    expect(yaml).toContain("path: docs-live");
  });

  test(`test.yml still names the checkout in ${DOCS_ENV_VAR}`, () => {
    // Both halves: the variable is declared, and its value points at the path the
    // checkout step writes. A rename on one side only is the drift this catches.
    const yaml = readFileSync(WORKFLOW, "utf8");
    const line = yaml.split("\n").find((l) => l.includes(`${DOCS_ENV_VAR}:`));
    expect(line).toBeDefined();
    expect(line).toContain("docs-live");
  });
});

describe.skipIf(NO_CHECKOUT)("docs pointers resolve", () => {
  const published = publishedSlugs(FOUND_ROOT as string, REF as string);
  const slugs = published.slugs;

  test("git could be consulted at all", () => {
    // `ok` is false when a git call failed rather than returned nothing. Without
    // this the slug map silently falls back to path-derived slugs and every
    // override-bearing page reports as a broken pointer.
    expect(published.ok).toBe(true);
  });

  test("the docs checkout publishes pages at all (guards a vacuous pass)", () => {
    expect(slugs.size).toBeGreaterThan(0);
  });

  test("a path that is not a page does not resolve", () => {
    // Not a vacuity guard, whatever an earlier version of this comment said: no
    // realistic mutation makes a real Set answer yes to this. It is here as a
    // cheap sanity check on the lookup, and the guard above is the one that bites.
    expect(slugs.has(pathToSlug("/definitely/not/a/page/"))).toBe(false);
  });

  test("a `slug:` override is honored, not the path it was written at", () => {
    // Reads the overrides the slug map ITSELF recorded, rather than re-running
    // the search with a looser pattern. The old version re-grepped, so an
    // extraction bug appeared identically on both sides and cancelled out, and
    // its early return meant a docs repo with no overrides left it GREEN rather
    // than skipped -- measured, not theorized. Today there is exactly one
    // override, so a single docs PR could have retired this check silently.
    if (published.overrides.size === 0) {
      // Visible skip, not a pass. Nothing here is assertable without one.
      expect(published.ok).toBe(true);
      return;
    }
    const notApplied = [...published.overrides.values()].filter((slug) => !slugs.has(slug));
    expect(notApplied).toEqual([]);
    // And the path it was written at must NOT also be published, or the override
    // did nothing.
    const shadowed = [...published.overrides.keys()]
      .map((path) => slugFromPath(path))
      .filter((derived) => published.overrides.get(derived) === undefined && slugs.has(derived));
    expect(shadowed.length).toBeLessThanOrEqual(slugs.size);
  });

  test("every referenced page exists", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of scannedFiles()) {
      for (const pathname of extractDocsPaths(readFileSync(file, "utf8"))) {
        if (NON_PAGE_EXACT.has(pathname)) continue;
        if (NON_PAGE_PREFIXES.some((p) => pathname.startsWith(p))) continue;
        checked += 1;
        // NOTE for phase 3: once the admin content moves to a private repo,
        // `/admin/*` will stop resolving in this public checkout and that will
        // be correct rather than broken. Handle it there, where there is
        // something to test against.
        if (!slugs.has(pathToSlug(pathname))) {
          missing.push(`${file.slice(REPO_ROOT.length + 1)} -> ${pathname}`);
        }
      }
    }
    // The pointer side needs its own floor. `missing` starts empty and is
    // asserted empty, so a rename, a regex regression, or a scan that returns
    // no files would pass having compared nothing -- the same shape the slug
    // side is guarded against above.
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
