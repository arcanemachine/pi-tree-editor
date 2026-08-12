import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installNativeHooks } from "../src/native/internal-imports.js";
import {
  selectorState,
  setActiveMode,
  setExtensionContext,
} from "../src/native/patch-state.js";

describe("native tree editor interaction", () => {
  it("uses selector-local input for inserting a note", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { initTheme } = await import(
      new URL(
        "./modes/interactive/theme/theme.js",
        await import.meta.resolve("@earendil-works/pi-coding-agent"),
      ).href
    );
    initTheme("dark", false);
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-ui-test");
    const leafId = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    setActiveMode({ sessionManager: manager } as never);
    setExtensionContext({
      hasUI: true,
      ui: {
        notify: () => undefined,
        select: async () => undefined,
        editor: async () => {
          throw new Error("modal editor should not be used");
        },
      },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    expect(selector.render(100).join("\n")).toContain("Tab edit mode");
    selector.handleInput("\t");
    expect(selector.render(100).join("\n")).toContain("Tree editor ON");
    selector.handleInput("a");
    selector.handleInput("n");
    selector.handleInput("o");
    selector.handleInput("t");
    selector.handleInput("e");
    selector.handleInput("\r");
    const state = selectorState(selector);
    expect(state.inlineInput).toBeUndefined();
    expect(state.operations).toEqual([
      {
        kind: "insert-note",
        anchorUnitId: leafId,
        position: "after",
        text: "note",
      },
    ]);

    selector.handleInput("s");
    expect(selectorState(selector).flow).toBe("save-review");
    expect(selector.render(100).join("\n")).toContain("review: A apply");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);

    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBe("exit-confirm");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);
  });

  it("keeps long-message tree rendering bounded while navigating", async () => {
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-overflow-test",
    );
    let parent: string | null = null;
    for (let index = 0; index < 12; index += 1) {
      parent = manager.appendMessage({
        role: "user",
        content: `${index}: ${"long message content ".repeat(20)}`,
        timestamp: index,
      });
    }
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      parent,
      24,
      () => undefined,
      () => undefined,
    );
    const list = selector.getTreeList();
    const initialCount = list.render(48).length;
    for (let index = 0; index < 20; index += 1) {
      selector.handleInput(index % 2 === 0 ? "\u001b[B" : "\u001b[A");
      const lines = list.render(48);
      expect(lines).toHaveLength(initialCount);
      expect(lines.every((line: string) => visibleWidth(line) <= 48)).toBe(
        true,
      );
    }
    selector.handleInput("\t");
    expect(list.render(48)).toHaveLength(initialCount);
    expect(
      selector.render(48).every((line: string) => visibleWidth(line) <= 48),
    ).toBe(true);
  });

  it("requires an explicit discard choice to exit with no staged changes", async () => {
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-exit-test");
    const leafId = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    setActiveMode({ sessionManager: manager } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    let exited = false;
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => {
        exited = true;
      },
    );
    selector.handleInput("\t");
    expect(selector.render(100).join("\n")).toContain("Escape confirms exit");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBe("exit-confirm");
    selector.handleInput("k");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).editMode).toBe(true);
    expect(exited).toBe(false);
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBe("exit-confirm");
    selector.handleInput("d");
    expect(exited).toBe(true);
  });
});
