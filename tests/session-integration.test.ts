import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applySurgery } from "../src/surgery/replay.js";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

function managerEntries(manager: SessionManager): SessionEntryLike[] {
  return manager.getEntries() as unknown as SessionEntryLike[];
}

describe("current Pi SessionManager integration", () => {
  it("reconstructs an edited context without changing source entries", async () => {
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-test");
    const userId = manager.appendMessage({
      role: "user",
      content: "old",
      timestamp: 1,
    });
    const assistantId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const before = structuredClone(managerEntries(manager));
    const plan = planSurgery({
      entries: before,
      leafId: assistantId,
      operations: [{ kind: "edit-text", entryId: userId, text: "new" }],
    });
    const result = await applySurgery(manager as never, plan);
    const after = managerEntries(manager);
    expect(after.find((entry) => entry.id === userId)).toEqual(
      before.find((entry) => entry.id === userId),
    );
    expect(
      after.find((entry) => entry.id === result.oldToNew[userId])?.parentId,
    ).toBe(null);
    expect(manager.getLeafId()).toBe(result.auditEntryId);
    expect(
      manager
        .buildSessionContext()
        .messages.some((message) => JSON.stringify(message).includes("new")),
    ).toBe(true);
  });

  it("preserves interleaved custom messages while reconstructing a tool exchange", async () => {
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-interleaved-test",
    );
    const userId = manager.appendMessage({
      role: "user",
      content: "run",
      timestamp: 1,
    });
    const callId = manager.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    const noteId = manager.appendCustomMessageEntry(
      "inter-agent-message",
      "status",
      true,
    );
    const resultId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    });
    const leafId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const before = structuredClone(managerEntries(manager));
    const plan = planSurgery({
      entries: before,
      leafId,
      operations: [{ kind: "edit-text", entryId: userId, text: "changed" }],
    });
    await applySurgery(manager as never, plan);

    const active = manager.getBranch();
    const activeNote = active.find(
      (entry) => entry.type === "custom_message" && entry.content === "status",
    );
    const activeCall = active.find(
      (entry) =>
        entry.type === "message" &&
        (entry.message as { role?: string }).role === "assistant" &&
        Array.isArray((entry.message as { content?: unknown }).content) &&
        (entry.message as { content: Array<{ type?: string }> }).content[0]
          ?.type === "toolCall",
    );
    const activeResult = active.find(
      (entry) =>
        entry.type === "message" &&
        (entry.message as { role?: string }).role === "toolResult",
    );
    expect(active.find((entry) => entry.id === noteId)).toBeUndefined();
    expect(active.find((entry) => entry.id === callId)).toBeUndefined();
    expect(active.find((entry) => entry.id === resultId)).toBeUndefined();
    expect(activeNote?.parentId).toBe(activeCall?.id);
    expect(activeResult?.parentId).toBe(activeNote?.id);
    expect(
      manager
        .buildSessionContext()
        .messages.some((message) => JSON.stringify(message).includes("status")),
    ).toBe(true);
  });

  it("inserts a visible context note into the effective context", async () => {
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-note-test");
    const userId = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    const before = managerEntries(manager);
    const plan = planSurgery({
      entries: before,
      leafId: userId,
      operations: [
        {
          kind: "insert-note",
          anchorUnitId: userId,
          position: "after",
          text: "remember this",
        },
      ],
    });
    const result = await applySurgery(manager as never, plan);
    expect(result.insertedNoteIds).toHaveLength(1);
    expect(
      manager
        .buildSessionContext()
        .messages.some((message) =>
          JSON.stringify(message).includes("remember this"),
        ),
    ).toBe(true);
  });

  it("keeps tool calls and results together when removing the exchange", async () => {
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-tool-test");
    const userId = manager.appendMessage({
      role: "user",
      content: "run",
      timestamp: 1,
    });
    const callId = manager.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    const resultId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    });
    const leafId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const before = managerEntries(manager);
    const plan = planSurgery({
      entries: before,
      leafId,
      operations: [{ kind: "remove-unit", unitId: callId }],
    });
    expect(plan.removedEntryIds).toEqual([callId, resultId]);
    await applySurgery(manager as never, plan);
    const active = manager.getBranch().map((entry) => entry.id);
    expect(active).not.toContain(callId);
    expect(active).not.toContain(resultId);
    expect(active).toContain(userId);
    expect(
      manager
        .buildSessionContext()
        .messages.some((message) => JSON.stringify(message).includes("done")),
    ).toBe(true);
  });
});
