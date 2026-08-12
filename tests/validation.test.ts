import { describe, expect, it } from "vitest";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

function user(id: string, parentId: string | null): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "old",
    message: { role: "user", content: id },
  };
}

describe("surgery validation", () => {
  it("rejects edit/remove conflicts regardless of operation order", () => {
    const entries = [user("u", null)];
    for (const operations of [
      [
        { kind: "edit-text" as const, entryId: "u", text: "new" },
        { kind: "remove-unit" as const, unitId: "u" },
      ],
      [
        { kind: "remove-unit" as const, unitId: "u" },
        { kind: "edit-text" as const, entryId: "u", text: "new" },
      ],
    ]) {
      expect(() => planSurgery({ entries, leafId: "u", operations })).toThrow(
        /already marked for removal|both edited and removed/,
      );
    }
  });

  it("rejects removal of structural entries", () => {
    const entries: SessionEntryLike[] = [
      user("u", null),
      {
        type: "model_change",
        id: "m",
        parentId: "u",
        timestamp: "old",
        provider: "openai",
        modelId: "test",
      },
    ];
    expect(() =>
      planSurgery({
        entries,
        leafId: "m",
        operations: [{ kind: "remove-unit", unitId: "m" }],
      }),
    ).toThrow("structural");
  });
});
