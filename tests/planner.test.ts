import { describe, expect, it } from "vitest";
import {
  buildLogicalUnits,
  editableTextBlocks,
} from "../src/surgery/logical-units.js";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

function entry(
  id: string,
  parentId: string | null,
  message: Record<string, unknown>,
): SessionEntryLike {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

const user = (id: string, parentId: string | null, text: string) =>
  entry(id, parentId, { role: "user", content: text, timestamp: 0 });

const assistant = (id: string, parentId: string | null, text: string) =>
  entry(id, parentId, {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
  });

describe("logical units", () => {
  it("groups a complete assistant tool exchange", () => {
    const path = [
      user("u", null, "run"),
      entry("a", "u", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
      entry("r", "a", {
        role: "toolResult",
        toolCallId: "call-1",
        content: "ok",
      }),
      assistant("a2", "r", "done"),
    ];
    const result = buildLogicalUnits(path);
    expect(result.issues).toEqual([]);
    expect(result.units[1]?.kind).toBe("tool-exchange");
    expect(result.units[1]?.entryIds).toEqual(["a", "r"]);
  });

  it("finds text blocks without treating images as editable", () => {
    const target = entry("u", null, {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "opaque" },
        { type: "text", text: "world" },
      ],
    });
    expect(editableTextBlocks(target).map((block) => block.blockIndex)).toEqual(
      [0, 2],
    );
  });
});

describe("planSurgery", () => {
  it("edits one block while preserving images", () => {
    const entries = [user("u", null, "hello"), assistant("a", "u", "old")];
    const plan = planSurgery({
      entries,
      leafId: "a",
      operations: [{ kind: "edit-text", entryId: "u", text: "new" }],
    });
    expect(plan.prefix).toEqual([]);
    expect(plan.replay[0]?.kind).toBe("entry");
    if (plan.replay[0]?.kind !== "entry")
      throw new Error("expected replay entry");
    expect((plan.replay[0].entry.message as { content: unknown }).content).toBe(
      "new",
    );
    expect((entries[0]?.message as { content: unknown }).content).toBe("hello");
  });

  it("clears stale assistant completion metadata when text changes", () => {
    const entries = [
      user("u", null, "hello"),
      {
        ...assistant("a", "u", "old"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old" }],
          usage: { totalTokens: 10 },
          errorMessage: "stale",
          stopReason: "error",
        },
      },
    ];
    const plan = planSurgery({
      entries,
      leafId: "a",
      operations: [{ kind: "edit-text", entryId: "a", text: "new" }],
    });
    const replayEntry = plan.replay.find((item) => item.kind === "entry");
    if (!replayEntry || replayEntry.kind !== "entry")
      throw new Error("expected replay entry");
    const message = replayEntry.entry.message as Record<string, unknown>;
    expect(message.stopReason).toBe("stop");
    expect(message.usage).toEqual(
      expect.objectContaining({ input: 0, output: 0, totalTokens: 0 }),
    );
    expect(message.errorMessage).toBeUndefined();
  });

  it("removes a whole tool exchange, not one half", () => {
    const entries = [
      user("u", null, "run"),
      entry("a", "u", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
      entry("r", "a", {
        role: "toolResult",
        toolCallId: "call-1",
        content: "ok",
      }),
      assistant("a2", "r", "done"),
    ];
    const plan = planSurgery({
      entries,
      leafId: "a2",
      operations: [{ kind: "remove-unit", unitId: "a" }],
    });
    expect(plan.removedEntryIds).toEqual(["a", "r"]);
  });

  it("rejects unresolved compaction boundaries", () => {
    const entries: SessionEntryLike[] = [
      user("u", null, "hello"),
      {
        type: "compaction",
        id: "c",
        parentId: "u",
        timestamp: new Date(0).toISOString(),
        summary: "summary",
        firstKeptEntryId: "missing",
        tokensBefore: 10,
      },
    ];
    expect(() =>
      planSurgery({
        entries,
        leafId: "c",
        operations: [{ kind: "edit-text", entryId: "u", text: "changed" }],
      }),
    ).toThrow("unresolved firstKeptEntryId");
  });
});
