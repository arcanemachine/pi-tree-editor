import { describe, expect, it } from "vitest";
import { applySurgery } from "../src/surgery/replay.js";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

class FakeManager {
  entries: SessionEntryLike[];
  leaf: string | null;
  counter = 0;

  constructor(entries: SessionEntryLike[], leaf: string) {
    this.entries = structuredClone(entries);
    this.leaf = leaf;
  }

  getEntries() {
    return this.entries.slice();
  }
  getLeafId() {
    return this.leaf;
  }
  branch(id: string) {
    this.leaf = id;
  }
  resetLeaf() {
    this.leaf = null;
  }
  append(entry: Omit<SessionEntryLike, "id" | "parentId">) {
    const id = `new-${++this.counter}`;
    const value = { ...entry, id, parentId: this.leaf } as SessionEntryLike;
    this.entries.push(value);
    this.leaf = id;
    return id;
  }
  appendMessage(message: unknown) {
    return this.append({ type: "message", timestamp: "now", message });
  }
  appendCustomEntry(customType: string, data?: unknown) {
    return this.append({ type: "custom", timestamp: "now", customType, data });
  }
  appendCustomMessageEntry(
    customType: string,
    content: unknown,
    display: boolean,
    details?: unknown,
  ) {
    return this.append({
      type: "custom_message",
      timestamp: "now",
      customType,
      content,
      display,
      details,
    });
  }
  appendThinkingLevelChange(thinkingLevel: string) {
    return this.append({
      type: "thinking_level_change",
      timestamp: "now",
      thinkingLevel,
    });
  }
  appendModelChange(provider: string, modelId: string) {
    return this.append({
      type: "model_change",
      timestamp: "now",
      provider,
      modelId,
    });
  }
}

function user(
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

describe("applySurgery", () => {
  it("creates an alternate append-only branch and audit entry", async () => {
    const entries = [user("u", null, "old"), user("u2", "u", "tail")];
    const manager = new FakeManager(entries, "u2");
    const plan = planSurgery({
      entries,
      leafId: "u2",
      operations: [{ kind: "edit-text", entryId: "u", text: "new" }],
    });
    const result = await applySurgery(manager, plan);
    expect(result.auditEntryId).toBe("new-3");
    expect(
      (
        manager.entries.filter((entry) => entry.id === "u")[0]?.message as {
          content: unknown;
        }
      ).content,
    ).toBe("old");
    expect(
      (
        manager.entries.find((entry) => entry.id === "new-1")?.message as {
          content: unknown;
        }
      ).content,
    ).toBe("new");
    expect(manager.entries.at(-1)?.type).toBe("custom");
    expect(manager.entries.at(-1)?.customType).toBe("pi-tree-editor.surgery");
  });

  it("forces native navigation to rebuild from the reconstructed audit leaf", async () => {
    const entries = [user("u", null, "old")];
    const manager = new FakeManager(entries, "u");
    let leafBeforeNavigation: string | null = null;
    const plan = planSurgery({
      entries,
      leafId: "u",
      operations: [{ kind: "edit-text", entryId: "u", text: "new" }],
    });
    const result = await applySurgery(manager, plan, {
      navigateTree: async (targetId) => {
        leafBeforeNavigation = manager.getLeafId();
        manager.leaf = targetId;
        return { cancelled: false };
      },
    });
    expect(leafBeforeNavigation).toBe("u");
    expect(manager.getLeafId()).toBe(result.auditEntryId);
  });

  it("records a recovery marker after an append failure", async () => {
    const entries = [user("u", null, "old")];
    const manager = new FakeManager(entries, "u");
    manager.appendMessage = () => {
      throw new Error("boom");
    };
    const plan = planSurgery({
      entries,
      leafId: "u",
      operations: [{ kind: "edit-text", entryId: "u", text: "new" }],
    });
    await expect(applySurgery(manager, plan)).rejects.toThrow("boom");
    expect(manager.entries.at(-1)?.customType).toBe("pi-tree-editor.recovery");
  });
});
