import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applySurgery } from "../src/surgery/replay.js";
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

describe("inserted message roles", () => {
  it("plans all explicit insert roles with role-safe replay", () => {
    const entries = [user("u", null), user("v", "u")];
    const plan = planSurgery({
      entries,
      leafId: "v",
      operations: [
        {
          kind: "insert",
          anchorUnitId: "u",
          position: "before",
          role: "user",
          text: "new user",
        },
        {
          kind: "insert",
          anchorUnitId: "v",
          position: "after",
          role: "assistant",
          text: "new answer",
          assistant: { api: "openai", provider: "openai", model: "test" },
        },
      ],
    });
    expect(plan.replay.map((item) => item.kind)).toEqual([
      "insert",
      "entry",
      "entry",
      "insert",
    ]);
    expect(plan.insertedEntryIds).toHaveLength(2);
    expect(plan.insertedNoteIds).toHaveLength(0);
  });

  it("applies user and assistant inserts without changing source entries", async () => {
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-role-test");
    const userId = manager.appendMessage({
      role: "user",
      content: "original",
      timestamp: 1,
    });
    const anchorId = manager.appendMessage({
      role: "user",
      content: "anchor",
      timestamp: 2,
    });
    const before = structuredClone(manager.getEntries());
    const plan = planSurgery({
      entries: before as SessionEntryLike[],
      leafId: anchorId,
      operations: [
        {
          kind: "insert",
          anchorUnitId: userId,
          position: "before",
          role: "user",
          text: "inserted user",
        },
        {
          kind: "insert",
          anchorUnitId: anchorId,
          position: "after",
          role: "assistant",
          text: "inserted assistant",
          assistant: { api: "openai", provider: "openai", model: "test" },
        },
      ],
    });
    const result = await applySurgery(manager as never, plan);
    expect(manager.getEntries().find((entry) => entry.id === userId)).toEqual(
      before.find((entry) => entry.id === userId),
    );
    const inserted = result.insertedEntryIds.map(
      (id) =>
        manager.getEntries().find((entry) => entry.id === id) as
          | SessionEntryLike
          | undefined,
    );
    expect(inserted[0]?.message).toMatchObject({
      role: "user",
      content: "inserted user",
    });
    expect(inserted[1]?.message).toMatchObject({
      role: "assistant",
      content: "inserted assistant",
      api: "openai",
      provider: "openai",
      model: "test",
      stopReason: "stop",
    });
    expect(inserted[1]?.message).not.toHaveProperty("thinkingSignature");
  });

  it("applies a context insert as a visible custom message", async () => {
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-context-role-test",
    );
    const anchorId = manager.appendMessage({
      role: "user",
      content: "anchor",
      timestamp: 1,
    });
    const plan = planSurgery({
      entries: manager.getEntries() as SessionEntryLike[],
      leafId: anchorId,
      operations: [
        {
          kind: "insert",
          anchorUnitId: anchorId,
          position: "after",
          role: "context",
          text: "context note",
        },
      ],
    });
    const result = await applySurgery(manager as never, plan);
    expect(result.insertedNoteIds).toHaveLength(1);
    expect(
      manager
        .getEntries()
        .find((entry) => entry.id === result.insertedNoteIds[0]),
    ).toMatchObject({
      type: "custom_message",
      customType: "pi-tree-editor.note",
      content: "context note",
      display: true,
    });
  });

  it("fails closed when assistant identity is unavailable", () => {
    expect(() =>
      planSurgery({
        entries: [user("u", null)],
        leafId: "u",
        operations: [
          {
            kind: "insert",
            anchorUnitId: "u",
            position: "after",
            role: "assistant",
            text: "answer",
          },
        ],
      }),
    ).toThrow("active model api, provider, and model identity");
  });
});
