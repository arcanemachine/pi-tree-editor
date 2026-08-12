import { SurgeryError, type SessionEntryLike } from "./types.js";

export function indexEntries(
  entries: SessionEntryLike[],
): Map<string, SessionEntryLike> {
  const byId = new Map<string, SessionEntryLike>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new SurgeryError(
        "DUPLICATE_ENTRY_ID",
        `Duplicate session entry id: ${entry.id}`,
      );
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

export function activePath(
  entries: SessionEntryLike[],
  leafId: string | null,
): SessionEntryLike[] {
  if (!leafId) return [];
  const byId = indexEntries(entries);
  const reversed: SessionEntryLike[] = [];
  const seen = new Set<string>();
  let current: string | null = leafId;
  while (current) {
    if (seen.has(current)) {
      throw new SurgeryError(
        "PARENT_CYCLE",
        `Cycle detected at entry ${current}`,
      );
    }
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) {
      throw new SurgeryError(
        "MISSING_PARENT",
        `Active path references missing entry ${current}`,
      );
    }
    reversed.push(entry);
    current = entry.parentId;
  }
  return reversed.reverse();
}

export function pathEntryMap(path: SessionEntryLike[]): Map<string, number> {
  return new Map(path.map((entry, index) => [entry.id, index]));
}
