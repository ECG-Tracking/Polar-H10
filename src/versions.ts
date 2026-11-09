// Older versions of a report, kept in the history for a week after a newer one replaced them, then moved to the Recovery
// centre (and deleted from it for good after four weeks). A record notes which versions it retired, so another device's
// copy, merged at the next sync, doesn't bring them back; a version restored from the Recovery centre is noted as kept.

/** A superseded version stays in the history this long after the newer one was made. */
export const VERSION_KEEP_MS = 7 * 24 * 3600 * 1000;
/** A retired version is deleted from the Recovery centre for good this long after it was put there. */
export const VERSION_BIN_MS = 28 * 24 * 3600 * 1000;

export interface Retirement { retired?: number[]; kept?: number[] }

const union = (a: readonly number[] = [], b: readonly number[] = []): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);

/** Both devices' notes together; empty lists are left out. */
export function mergeRetirement(a: Retirement | undefined, b: Retirement | undefined): Retirement {
  const retired = union(a?.retired, b?.retired), kept = union(a?.kept, b?.kept);
  return { ...(retired.length ? { retired } : {}), ...(kept.length ? { kept } : {}) };
}

/** Whether this version was retired (and not restored since). */
export const isRetired = (generatedAt: number, r: Retirement | undefined): boolean =>
  (r?.retired ?? []).includes(generatedAt) && !(r?.kept ?? []).includes(generatedAt);

/** The versions still shown, oldest first; the newest always stays. */
export function shown<V extends { generatedAt: number }>(versions: readonly V[], r: Retirement | undefined): V[] {
  return versions.filter((v, i) => i === versions.length - 1 || !isRetired(v.generatedAt, r));
}

/** Versions (oldest first) to retire now: replaced by a newer one more than a week ago, and not restored by the person. */
export function dueVersions<V extends { generatedAt: number }>(versions: readonly V[], r: Retirement | undefined, now: number): V[] {
  return versions.filter((v, i) => {
    const next = versions[i + 1];
    return next != null && now - next.generatedAt > VERSION_KEEP_MS && !(r?.kept ?? []).includes(v.generatedAt) && !(r?.retired ?? []).includes(v.generatedAt);
  });
}
