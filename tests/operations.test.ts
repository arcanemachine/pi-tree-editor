import { describe, expect, it } from "vitest";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

function message(
  id: string,
  parentId: string | null,
  text: string,
): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "old",
    message: { role: "user", content: text },
  };
}

describe("insert-note operations", () => {
  it("retains an after-note at the end of the active path", () => {
    const entries = [message("u", null, "hello")];
    const plan = planSurgery({
      entries,
      leafId: "u",
      operations: [
        {
          kind: "insert-note",
          anchorUnitId: "u",
          position: "after",
          text: "remember",
        },
      ],
    });
    expect(plan.replay.map((item) => item.kind)).toEqual([
      "entry",
      "insert-note",
    ]);
    expect(plan.replay.at(-1)?.kind).toBe("insert-note");
  });
});
