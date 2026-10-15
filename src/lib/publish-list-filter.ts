/**
 * Which publication requests `nemar admin publish list` asks for.
 *
 * The default is the requests that still need somebody: an administrator
 * reading the list wants what is open, not the history. A state flag narrows to
 * that state, several widen to their union, and `--all` is every request.
 */

export const ACTIVE_STATUSES = ["requested", "approving", "blocked"] as const;

export const STATE_FLAGS = ["requested", "approving", "blocked", "published", "denied"] as const;

export type StateFlag = (typeof STATE_FLAGS)[number];

export interface ListFilterOptions {
  all?: boolean;
  requested?: boolean;
  approving?: boolean;
  blocked?: boolean;
  published?: boolean;
  denied?: boolean;
  /**
   * `-s, --status <status>`: the exact status (or a comma-separated list) the
   * command always took, kept so a script or a habit written before the state
   * flags existed still means what it did.
   */
  status?: string;
}

/**
 * The statuses to request, or `undefined` for every request. `--all` wins over
 * the state flags and `--status`, because "everything" already contains them.
 * The state flags and `--status` together are the union of what they name.
 */
export function resolveListStatuses(options: ListFilterOptions): string[] | undefined {
  if (options.all) return undefined;
  const wanted = new Set<string>(namedStatuses(options));
  for (const flag of STATE_FLAGS) if (options[flag]) wanted.add(flag);
  if (wanted.size === 0) return [...ACTIVE_STATUSES];
  // Known statuses in the flags' own order, so the request does not depend on
  // which way the same states were typed; anything else (a typo the server
  // will refuse by name) follows.
  const known = STATE_FLAGS.filter((flag) => wanted.has(flag));
  return [...known, ...[...wanted].filter((status) => !(known as string[]).includes(status))];
}

function namedStatuses(options: ListFilterOptions): string[] {
  return (options.status ?? "")
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
}

/** Whether the administrator picked a scope, as opposed to taking the default. */
export function choseListScope(options: ListFilterOptions): boolean {
  return (
    options.all === true ||
    STATE_FLAGS.some((flag) => options[flag]) ||
    namedStatuses(options).length > 0
  );
}

/** What the list is showing, in the words of the flags that produced it. */
export function describeListScope(options: ListFilterOptions): string {
  const statuses = resolveListStatuses(options);
  if (!statuses) return "all requests";
  if (!choseListScope(options)) return "active requests";
  return `requests with status ${statuses.join(" or ")}`;
}
