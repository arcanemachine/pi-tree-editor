import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
    expect(selector.render(100).join("\n")).toContain(
      "review: A apply changes",
    );
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);

    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBe("exit-confirm");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);
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
    expect(selector.render(100).join("\n")).toContain(
      "Escape opens exit confirmation",
    );
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
