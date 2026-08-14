import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applySurgery } from "../src/surgery/replay.js";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

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
      content: [{ type: "text", text: "inserted assistant" }],
      api: "openai",
      provider: "openai",
      model: "test",
      stopReason: "stop",
    });
    expect(inserted[1]?.message).not.toHaveProperty("thinkingSignature");
  });

  it("keeps mixed assistant-after-user and user-before-assistant inserts canonical", async () => {
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-mixed-insert-order-test",
    );
    const userOne = manager.appendMessage({
      role: "user",
      content: "first user",
      timestamp: 1,
    });
    const assistantOne = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const userTwo = manager.appendMessage({
      role: "user",
      content: "second user",
      timestamp: 3,
    });
    const assistantTwo = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: 4,
    });
    const before = structuredClone(manager.getEntries());
    const plan = planSurgery({
      entries: before as SessionEntryLike[],
      leafId: assistantTwo,
      operations: [
        {
          kind: "insert",
          anchorUnitId: userOne,
          position: "after",
          role: "assistant",
          text: "inserted answer",
          assistant: { api: "openai", provider: "openai", model: "test" },
        },
        {
          kind: "insert",
          anchorUnitId: assistantTwo,
          position: "before",
          role: "user",
          text: "inserted user",
        },
      ],
    });
    const result = await applySurgery(manager as never, plan);
    const entries = manager.getEntries() as SessionEntryLike[];
    const insertedAssistant = entries.find(
      (entry) =>
        entry.id === result.insertedEntryIds[0] &&
        (entry.message as { role?: string })?.role === "assistant",
    )!;
    const insertedUser = entries.find(
      (entry) =>
        entry.id === result.insertedEntryIds[1] &&
        (entry.message as { role?: string })?.role === "user",
    )!;
    const replayedAssistant = entries.find(
      (entry) => entry.id === result.oldToNew[assistantTwo],
    )!;
    expect(insertedAssistant.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "inserted answer" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: zeroUsage(),
      stopReason: "stop",
    });
    expect(insertedAssistant.message).not.toHaveProperty("thinking");
    expect(insertedAssistant.message).not.toHaveProperty("thinkingSignature");
    expect(insertedAssistant.message).not.toHaveProperty("toolCall");
    expect(insertedAssistant.parentId).toBe(result.oldToNew[userOne]);
    expect(insertedUser.message).toMatchObject({
      role: "user",
      content: "inserted user",
    });
    expect(insertedUser.parentId).toBe(result.oldToNew[userTwo]);
    expect(replayedAssistant.parentId).toBe(insertedUser.id);
    expect(entries.indexOf(insertedUser)).toBeLessThan(
      entries.indexOf(replayedAssistant),
    );
    expect(entries.filter((entry) => entry.id === userOne)[0]).toEqual(
      before.find((entry) => entry.id === userOne),
    );
    expect(entries.filter((entry) => entry.id === assistantOne)[0]).toEqual(
      before.find((entry) => entry.id === assistantOne),
    );
    expect(manager.buildSessionContext()).toBeDefined();
    const audit = entries.find((entry) => entry.id === result.auditEntryId);
    const auditData = JSON.stringify(audit?.data);
    expect(auditData).not.toContain("inserted answer");
    expect(auditData).not.toContain("inserted user");
    expect(auditData).toContain('"role":"assistant"');
    expect(auditData).toContain('"textLength":15');
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
