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
    const notifications: string[] = [];
    setExtensionContext({
      hasUI: true,
      ui: {
        notify: (message: string) => notifications.push(message),
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
    expect(selector.render(100).join("\n")).toContain(
      "Tree editor ON: ctrl+s save · e edit · d remove · a/Shift+A insert · u unstage",
    );
    expect(notifications.at(-1)).toContain(
      "Tree editor mode: ctrl+s save, e edit, d remove, a insert, u unstage",
    );
    selector.handleInput("a");
    expect(selectorState(selector).flow).toBe("role-choice");
    expect(selector.render(100).join("\n")).toContain("User");
    selector.handleInput("\r");
    selector.handleInput("n");
    selector.handleInput("o");
    selector.handleInput("t");
    selector.handleInput("e");
    selector.handleInput("\r");
    const state = selectorState(selector);
    expect(state.inlineInput).toBeUndefined();
    expect(state.operations).toEqual([
      {
        kind: "insert",
        anchorUnitId: leafId,
        position: "after",
        role: "user",
        text: "note",
      },
    ]);

    selector.handleInput("\x13");
    expect(selectorState(selector).flow).toBe("save-review");
    expect(selector.render(100).join("\n")).toContain(
      "Tree editor save: ctrl+s · Yes apply · Cancel keep staged",
    );
    expect(selector.render(100).join("\n")).toContain("Save 1 staged item?");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);

    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBe("exit-confirm");
    expect(selector.render(100).join("\n")).toContain(
      "Save changes to 1 staged item?",
    );
    expect(selector.render(100).join("\n")).toContain(
      "→ Yes. Return to conversation",
    );
    expect(selector.render(100).join("\n")).toContain(
      "No. Return to tree and continue making changes",
    );
    expect(selector.render(100).join("\n")).toContain(
      "No. Return to conversation and abandon staged changes",
    );
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

  it("exits directly with no staged changes", async () => {
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
    expect(selector.render(100).join("\n")).toContain("Tree editor ON");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).editMode).toBe(false);
    expect(exited).toBe(true);
  });

  it("navigates confirmation menus and preserves staged work", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory("/tmp/pi-tree-editor-menu-test");
    const leafId = manager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      isIdle: () => true,
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
    selector.handleInput("a");
    selector.handleInput("n");
    selector.handleInput("o");
    selector.handleInput("t");
    selector.handleInput("e");
    selector.handleInput("\r");
    selector.handleInput("s");
    expect(selector.render(48).join("\n")).toContain("→ Yes");
    selector.handleInput("\u001b[B");
    expect(selector.render(48).join("\n")).toContain("→ Cancel");
    selector.handleInput("\r");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);
    expect(exited).toBe(false);

    selector.handleInput("s");
    selector.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(selectorState(selector).editMode).toBe(false);
    expect(exited).toBe(true);

    const exitManager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-menu-exit-test",
    );
    const exitLeafId = exitManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: exitManager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    let exitDiscarded = false;
    const exitSelector = new TreeSelectorComponent(
      exitManager.getTree(),
      exitLeafId,
      30,
      () => undefined,
      () => {
        exitDiscarded = true;
      },
    );
    exitSelector.handleInput("\t");
    exitSelector.handleInput("a");
    exitSelector.handleInput("x");
    exitSelector.handleInput("\r");
    exitSelector.handleInput("\u001b");
    expect(selectorState(exitSelector).flow).toBe("exit-confirm");
    exitSelector.handleInput("\u001b[B");
    exitSelector.handleInput("\u001b[B");
    expect(exitSelector.render(48).join("\n")).toContain("→ No");
    exitSelector.handleInput("\r");
    expect(selectorState(exitSelector).operations).toHaveLength(0);
    expect(selectorState(exitSelector).editMode).toBe(false);
    expect(exitDiscarded).toBe(true);

    const applyManager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-menu-exit-apply-test",
    );
    const applyLeafId = applyManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: applyManager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    let exitApplied = false;
    const applySelector = new TreeSelectorComponent(
      applyManager.getTree(),
      applyLeafId,
      30,
      () => undefined,
      () => {
        exitApplied = true;
      },
    );
    applySelector.handleInput("\t");
    applySelector.handleInput("a");
    applySelector.handleInput("x");
    applySelector.handleInput("\r");
    applySelector.handleInput("\u001b");
    expect(applySelector.render(48).join("\n")).toContain(
      "→ Yes. Return to conversation",
    );
    applySelector.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selectorState(applySelector).operations).toHaveLength(0);
    expect(exitApplied).toBe(true);
  });

  it("keeps staged operations when save planning fails", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-menu-planning-failure-test",
    );
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
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("a");
    selector.handleInput("x");
    selector.handleInput("\r");
    const state = selectorState(selector);
    state.operations.push({
      kind: "edit-text",
      entryId: "missing-entry",
      blockIndex: 0,
      text: "invalid",
    });
    selector.handleInput("s");
    expect(state.flow).toBeUndefined();
    expect(state.operations).toHaveLength(2);
    expect(state.editMode).toBe(true);
  });

  it("keeps native selector height while editor states replace its content", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const nativeUrl = `${treeSelectorUrl}?native-height-regression`;
    const [
      { TreeSelectorComponent },
      { TreeSelectorComponent: NativeSelector },
    ] = await Promise.all([import(treeSelectorUrl), import(nativeUrl)]);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-height-regression",
    );
    const leafId = manager.appendMessage({
      role: "user",
      content: "long initial message\nwith multiple lines\n".repeat(4),
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
    const widths = [100, 48, 24, 18, 12, 4, 1];
    const createSelector = (Selector: typeof TreeSelectorComponent) =>
      new Selector(
        manager.getTree(),
        leafId,
        30,
        () => undefined,
        () => undefined,
      );
    const selector = createSelector(TreeSelectorComponent);
    const native = createSelector(NativeSelector);
    const helpOf = (candidate: typeof selector) =>
      (
        candidate.children as Array<{
          constructor: { name?: string };
          render(width: number): string[];
        }>
      ).find((child) => child.constructor.name === "TreeHelp")!;
    const help = helpOf(selector);
    const nativeHelp = helpOf(native);
    const expectNativeHeight = () => {
      for (const width of widths) {
        const rendered = selector.render(width);
        const nativeRendered = native.render(width);
        const replacementRows = help.render(width);
        const nativeHelpRows = nativeHelp.render(width);
        expect(rendered).toHaveLength(nativeRendered.length);
        expect(replacementRows).toHaveLength(nativeHelpRows.length);
        expect(
          replacementRows.every((line: string) => visibleWidth(line) <= width),
          `replacement overflow at width ${width}`,
        ).toBe(true);
      }
    };

    expectNativeHeight();
    expect(selector.render(100).join("\n")).toContain(
      "Tree editor: Tab edit mode",
    );
    selector.handleInput("\t");
    expectNativeHeight();
    expect(selector.render(100).join("\n")).toContain("Tree editor ON");

    selector.handleInput("a");
    expect(selectorState(selector).flow).toBe("role-choice");
    expect(selector.render(100).join("\n")).toContain("Context note");
    selector.handleInput("\r");
    expect(selectorState(selector).inlineInput).toBeDefined();
    expect(selector.render(100).join("\n")).toContain("Tree editor input");
    native.treeContainer.clear();
    native.labelInputContainer.clear();
    native.labelInputContainer.addChild(
      selector.labelInputContainer.children[0],
    );
    expectNativeHeight();

    selector.handleInput("x");
    selector.handleInput("\r");
    selector.handleInput("\x13");
    expect(selectorState(selector).flow).toBe("save-review");
    expect(selector.render(100).join("\n")).toContain("Tree editor save");
    native.treeContainer.clear();
    native.labelInputContainer.clear();
    native.treeContainer.addChild(selector.labelInputContainer.children[0]);
    expectNativeHeight();

    selector.handleInput("\u001b");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBe("exit-confirm");
    expect(selector.render(100).join("\n")).toContain(
      "Exit menu: Yes save · No keep editing · No abandon",
    );
    native.treeContainer.clear();
    native.labelInputContainer.clear();
    native.treeContainer.addChild(selector.labelInputContainer.children[0]);
    expectNativeHeight();
  });

  it("keeps multiline inline edits stable and round-trips newlines", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-multiline-input-regression",
    );
    const text = "Quiet morning dew—\na single leaf catches the light.";
    const leafId = manager.appendMessage({
      role: "user",
      content: text,
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("e");
    expect(selectorState(selector).inlineInput).toBeDefined();

    const width = 32;
    const render = () => {
      const lines = selector.render(width);
      expect(
        lines.every(
          (line: string) =>
            !line.includes("\n") &&
            !line.includes("\r") &&
            visibleWidth(line) <= width,
        ),
      ).toBe(true);
      return lines;
    };
    const initialLines = render();
    for (let index = 0; index < 24; index += 1) {
      selector.handleInput(index % 2 === 0 ? "\u001b[D" : "\u001b[C");
      expect(render()).toHaveLength(initialLines.length);
    }

    selector.handleInput("\r");
    expect(selectorState(selector).inlineInput).toBeUndefined();
    expect(selectorState(selector).operations).toEqual([
      {
        kind: "edit-text",
        entryId: leafId,
        blockIndex: 0,
        text,
      },
    ]);

    selector.handleInput("e");
    expect(selectorState(selector).inlineInput).toBeDefined();
    selector.handleInput("\u001b");
    expect(selectorState(selector).inlineInput).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(1);
  });

  it("preserves multiline whitespace and newline forms", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const texts = [
      "  leading space\r\ntrailing space  ",
      "  leading carriage\rtrailing carriage  ",
    ];
    for (const text of texts) {
      const manager = SessionManager.inMemory(
        "/tmp/pi-tree-editor-multiline-whitespace-regression",
      );
      const leafId = manager.appendMessage({
        role: "user",
        content: text,
        timestamp: 1,
      });
      setActiveMode({
        sessionManager: manager,
        ui: { terminal: { rows: 40 }, requestRender: () => undefined },
      } as never);
      setExtensionContext({
        hasUI: true,
        ui: { notify: () => undefined },
      } as never);
      const selector = new TreeSelectorComponent(
        manager.getTree(),
        leafId,
        30,
        () => undefined,
        () => undefined,
      );
      selector.handleInput("\t");
      selector.handleInput("e");
      const lines = selector.render(32);
      expect(
        lines.every(
          (line: string) =>
            !line.includes("\n") &&
            !line.includes("\r") &&
            visibleWidth(line) <= 32,
        ),
      ).toBe(true);
      selector.handleInput("\r");
      expect(selectorState(selector).operations[0]).toMatchObject({
        kind: "edit-text",
        text,
      });
    }

    const changedText = "  keep leading\nkeep trailing  ";
    const changedManager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-multiline-changed-regression",
    );
    const changedLeafId = changedManager.appendMessage({
      role: "user",
      content: changedText,
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: changedManager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    const changedSelector = new TreeSelectorComponent(
      changedManager.getTree(),
      changedLeafId,
      30,
      () => undefined,
      () => undefined,
    );
    changedSelector.handleInput("\t");
    changedSelector.handleInput("e");
    changedSelector.handleInput("\n");
    changedSelector.handleInput("!");
    changedSelector.handleInput("\r");
    expect(selectorState(changedSelector).operations[0]).toMatchObject({
      kind: "edit-text",
      text: `${changedText}\n!`,
    });

    const revertedText = "  revert leading\r\nrevert trailing  ";
    const revertedManager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-multiline-revert-regression",
    );
    const revertedLeafId = revertedManager.appendMessage({
      role: "user",
      content: revertedText,
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: revertedManager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    const revertedSelector = new TreeSelectorComponent(
      revertedManager.getTree(),
      revertedLeafId,
      30,
      () => undefined,
      () => undefined,
    );
    revertedSelector.handleInput("\t");
    revertedSelector.handleInput("e");
    revertedSelector.handleInput("!");
    revertedSelector.handleInput("\x7f");
    revertedSelector.handleInput("\r");
    expect(selectorState(revertedSelector).operations[0]).toMatchObject({
      kind: "edit-text",
      text: revertedText,
    });
  });

  it("previews staged rows and markers without changing tree geometry", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-staged-display-regression",
    );
    manager.appendMessage({
      role: "user",
      content: "first entry",
      timestamp: 1,
    });
    manager.appendMessage({
      role: "user",
      content: "second entry",
      timestamp: 2,
    });
    const leafId = manager.appendMessage({
      role: "user",
      content: "editable entry",
      timestamp: 3,
    });
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    const render = (width: number) => {
      const lines = selector.render(width);
      expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(
        true,
      );
      return lines;
    };
    const normalHeight = render(48).length;

    selector.handleInput("\t");
    selector.handleInput("e");
    selector.handleInput("!");
    selector.handleInput("\r");
    const editedLines = render(48).join("\n");
    expect(editedLines).toContain("[edit]");
    expect(editedLines).toContain("!editable entry");
    const editedEntry = manager
      .getEntries()
      .find((entry) => entry.id === leafId) as
      | { message?: { content?: unknown } }
      | undefined;
    expect(editedEntry?.message?.content).toBe("editable entry");
    expect(render(48)).toHaveLength(normalHeight);

    selector.handleInput("u");
    const restoredLines = render(48).join("\n");
    expect(restoredLines).not.toContain("[edit]");
    expect(restoredLines).toContain("editable entry");

    selector.handleInput("d");
    expect(render(48).join("\n")).toContain("[remove]");
    selector.handleInput("u");
    expect(render(48).join("\n")).not.toContain("[remove]");

    selector.handleInput("a");
    selector.handleInput("n");
    selector.handleInput("o");
    selector.handleInput("t");
    selector.handleInput("e");
    selector.handleInput("\r");
    expect(render(48).join("\n")).toContain("[insert after]");
    selector.handleInput("u");
    expect(render(48).join("\n")).not.toContain("[insert after]");

    selector.handleInput("A");
    selector.handleInput("b");
    selector.handleInput("e");
    selector.handleInput("f");
    selector.handleInput("o");
    selector.handleInput("r");
    selector.handleInput("e");
    selector.handleInput("\r");
    expect(render(48).join("\n")).toContain("[insert before]");
    selector.handleInput("u");
    expect(render(48).join("\n")).not.toContain("[insert before]");

    for (const width of [100, 48, 24, 12, 4]) {
      const widthHeight = render(width).length;
      selector.handleInput("\u001b[A");
      expect(render(width)).toHaveLength(widthHeight);
      selector.handleInput("\u001b[B");
      expect(render(width)).toHaveLength(widthHeight);
    }
  });

  it("keeps one latest staged edit per entry without mutating it", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-multi-block-preview-regression",
    );
    const content = [
      { type: "text" as const, text: "first block" },
      { type: "text" as const, text: "second block" },
    ];
    const leafId = manager.appendMessage({
      role: "user",
      content,
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("e");
    selector.handleInput("1");
    selector.handleInput("A");
    selector.handleInput("\r");
    selector.handleInput("e");
    selector.handleInput("2");
    selector.handleInput("B");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toHaveLength(1);
    expect(selectorState(selector).operations[0]).toMatchObject({
      kind: "edit-text",
      blockIndex: 1,
      text: "Bsecond block",
    });
    const rendered = selector.render(80).join("\n");
    expect(rendered).toContain("[edit]");
    expect(rendered).not.toContain("Afirst block");
    expect(rendered).toContain("first blockBsecond block");
    const entry = manager
      .getEntries()
      .find((candidate) => candidate.id === leafId) as
      | { message?: { content?: unknown } }
      | undefined;
    expect(entry?.message?.content).toEqual(content);
  });

  it("replaces staged actions and unstages the selected unit", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const themeUrl = new URL(
      "./modes/interactive/theme/theme.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { initTheme } = await import(themeUrl);
    initTheme("dark", false);
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-latest-wins-regression",
    );
    const leafId = manager.appendMessage({
      role: "user",
      content: "selected",
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    const notifications: string[] = [];
    setExtensionContext({
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    const staged = () => selectorState(selector).operations;
    const render = () => selector.render(80).join("\n");
    const markerCount = () =>
      (render().match(/\[(?:edit|remove|insert before|insert after)\]/g) ?? [])
        .length;

    selector.handleInput("e");
    selector.handleInput("X");
    selector.handleInput("\r");
    expect(staged()).toHaveLength(1);
    expect(staged()[0]).toMatchObject({ kind: "edit-text", text: "Xselected" });
    expect(markerCount()).toBe(1);

    selector.handleInput("d");
    expect(staged()).toEqual([{ kind: "remove-unit", unitId: leafId }]);
    expect(render()).toContain("[remove]");
    expect(render()).not.toContain("[edit]");

    selector.handleInput("e");
    selector.handleInput("Y");
    selector.handleInput("\r");
    expect(staged()).toHaveLength(1);
    expect(staged()[0]).toMatchObject({ kind: "edit-text", text: "Yselected" });

    selector.handleInput("e");
    selector.handleInput("\r");
    expect(staged()[0]).toMatchObject({ kind: "edit-text", text: "Yselected" });

    selector.handleInput("a");
    selector.handleInput("n");
    selector.handleInput("\r");
    expect(staged()).toHaveLength(1);
    expect(staged()[0]).toMatchObject({
      kind: "insert-note",
      position: "after",
    });
    expect(render()).toContain("[insert after]");
    expect(markerCount()).toBe(1);

    selector.handleInput("e");
    selector.handleInput("Z");
    selector.handleInput("\r");
    expect(staged()[0]).toMatchObject({ kind: "edit-text", text: "Zselected" });
    expect(render()).not.toContain("[insert after]");

    selector.handleInput("d");
    expect(staged()).toEqual([{ kind: "remove-unit", unitId: leafId }]);
    selector.handleInput("A");
    selector.handleInput("b");
    selector.handleInput("\r");
    expect(staged()[0]).toMatchObject({
      kind: "insert-note",
      position: "before",
    });
    expect(render()).toContain("[insert before]");
    selector.handleInput("a");
    selector.handleInput("a");
    selector.handleInput("\r");
    expect(staged()[0]).toMatchObject({
      kind: "insert-note",
      position: "after",
    });
    expect(render()).not.toContain("[insert before]");
    expect(markerCount()).toBe(1);

    selector.handleInput("u");
    expect(staged()).toHaveLength(0);
    expect(render()).not.toMatch(
      /\[(?:edit|remove|insert before|insert after)\]/,
    );
    selector.handleInput("u");
    expect(notifications.at(-1)).toContain("No staged action");
    const entry = manager.getEntries().find((item) => item.id === leafId) as
      | { message?: { content?: unknown } }
      | undefined;
    expect(entry?.message?.content).toBe("selected");
  });

  it("unstages only the selected unit when several units are staged", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-selected-unstage-regression",
    );
    const firstId = manager.appendMessage({
      role: "user",
      content: "first",
      timestamp: 1,
    });
    const secondId = manager.appendMessage({
      role: "user",
      content: "second",
      timestamp: 2,
    });
    setActiveMode({ sessionManager: manager } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      secondId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("d");
    selector.handleInput("\u001b[A");
    selector.handleInput("d");
    expect(selectorState(selector).operations).toEqual([
      { kind: "remove-unit", unitId: secondId },
      { kind: "remove-unit", unitId: firstId },
    ]);
    selector.handleInput("\u001b[B");
    selector.handleInput("u");
    expect(selectorState(selector).operations).toEqual([
      { kind: "remove-unit", unitId: firstId },
    ]);
  });

  it("unstages a selected tool logical unit as one action", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-tool-unit-unstage-regression",
    );
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
      timestamp: 1,
    });
    const resultId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 2,
    });
    const before = structuredClone(manager.getEntries());
    setActiveMode({ sessionManager: manager } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      resultId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("d");
    expect(selectorState(selector).operations).toEqual([
      { kind: "remove-unit", unitId: callId },
    ]);
    expect(selector.render(80).join("\n")).toContain("[remove]");
    selector.handleInput("u");
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(manager.getEntries()).toEqual(before);
  });

  it("keeps legacy plain-string assistant text editable", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-legacy-assistant-regression",
    );
    const leafId = manager.appendMessage({
      role: "assistant",
      content: "legacy answer" as never,
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("e");
    expect(selectorState(selector).inlineInput).toBeDefined();
    selector.handleInput("!");
    selector.handleInput("\r");
    expect(selectorState(selector).operations[0]).toMatchObject({
      kind: "edit-text",
      entryId: leafId,
    });
  });

  it("refuses to remove an assistant's sole reasoning block", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const themeUrl = new URL(
      "./modes/interactive/theme/theme.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { initTheme } = await import(themeUrl);
    initTheme("dark", false);
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-sole-reasoning-regression",
    );
    const leafId = manager.appendMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "only thought" }],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    const notifications: string[] = [];
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    selector.handleInput("e");
    const input = selectorState(selector).inlineInput!.input as unknown as {
      setText?: (value: string) => void;
      setValue?: (value: string) => void;
    };
    if (input.setText) input.setText("");
    else input.setValue!("");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(selectorState(selector).inlineInput).toBeDefined();
    expect(notifications.at(-1)).toContain("only content block");
    selector.handleInput("\u001b");
  });

  it("shows and stages safe reasoning without mutating the source entry", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const themeUrl = new URL(
      "./modes/interactive/theme/theme.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { initTheme } = await import(themeUrl);
    initTheme("dark", false);
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-reasoning-ui-regression",
    );
    const leafId = manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect the repository" },
        { type: "text", text: "answer" },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    const original = structuredClone(manager.getEntries());
    setActiveMode({
      sessionManager: manager,
      ui: { terminal: { rows: 40 }, requestRender: () => undefined },
    } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    const firstReasonRender = selector.render(80);
    expect(firstReasonRender.join("\n")).toContain(
      "[reasoning: inspect the repository]",
    );
    selector.handleInput("e");
    expect(selector.render(80).join("\n")).toContain(
      "Reasoning — inspect the repository",
    );
    selector.handleInput("2");
    expect(selectorState(selector).inlineInput).toBeDefined();
    const setInlineText = (text: string) => {
      const input = selectorState(selector).inlineInput!.input as unknown as {
        setText?: (value: string) => void;
        setValue?: (value: string) => void;
      };
      if (input.setText) input.setText(text);
      else input.setValue!(text);
    };
    setInlineText("new thought");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toEqual([
      {
        kind: "edit-reasoning",
        entryId: leafId,
        blockIndex: 0,
        thinking: "new thought",
      },
    ]);
    const staged = selector.render(80).join("\n");
    expect(staged).toContain("[edit reasoning]");
    expect(staged).toContain("[reasoning: new thought]");
    expect(manager.getEntries()).toEqual(original);

    selector.handleInput("e");
    selector.handleInput("2");
    selector.handleInput("\r");
    expect(selectorState(selector).operations[0]).toMatchObject({
      kind: "edit-reasoning",
      thinking: "new thought",
    });
    selector.handleInput("u");
    selector.handleInput("e");
    selector.handleInput("2");
    setInlineText("");
    selector.handleInput("\r");
    expect(selectorState(selector).operations[0]).toMatchObject({
      kind: "edit-reasoning",
      thinking: "",
    });
    expect(selector.render(80).join("\n")).toContain("[reasoning: removed]");
    selector.handleInput("d");
    expect(selectorState(selector).operations).toEqual([
      { kind: "remove-unit", unitId: leafId },
    ]);
    selector.handleInput("e");
    selector.handleInput("2");
    setInlineText("restored thought");
    selector.handleInput("\r");
    expect(selectorState(selector).operations[0]).toMatchObject({
      kind: "edit-reasoning",
      thinking: "restored thought",
    });
    expect(
      selector.render(24).every((line: string) => visibleWidth(line) <= 24),
    ).toBe(true);
  });

  it("shows unsafe reasoning as read-only with a concise reason", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-unsafe-reasoning-ui-regression",
    );
    const leafId = manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "signed thought",
          thinkingSignature: "sig",
        },
        { type: "text", text: "answer" },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    setActiveMode({ sessionManager: manager } as never);
    const notifications: string[] = [];
    setExtensionContext({
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    selector.handleInput("\t");
    expect(selector.render(80).join("\n")).toContain(
      "[reasoning: signed thought]",
    );
    selector.handleInput("e");
    expect(selector.render(80).join("\n")).toContain(
      "Reasoning — read-only (provider-signed)",
    );
    selector.handleInput("2");
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(notifications.at(-1)).toContain("read-only");
  });

  it("stays bounded through repeated narrow multiline navigation and state changes", async () => {
    await installNativeHooks();
    const treeSelectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      await import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href;
    const { TreeSelectorComponent } = await import(treeSelectorUrl);
    const manager = SessionManager.inMemory(
      "/tmp/pi-tree-editor-narrow-overflow-regression",
    );
    let leafId: string | null = null;
    for (let index = 0; index < 18; index += 1) {
      leafId = manager.appendMessage({
        role: "user",
        content: `${"multiline long content ".repeat(12)}\n${"second line ".repeat(12)}`,
        timestamp: index,
      });
    }
    setActiveMode({ sessionManager: manager } as never);
    setExtensionContext({
      hasUI: true,
      ui: { notify: () => undefined },
    } as never);
    const selector = new TreeSelectorComponent(
      manager.getTree(),
      leafId,
      30,
      () => undefined,
      () => undefined,
    );
    const width = 10;
    const render = () => {
      const lines = selector.render(width);
      expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(
        true,
      );
      return lines.length;
    };
    const normalHeight = render();
    for (let index = 0; index < 30; index += 1) {
      selector.handleInput(index % 2 === 0 ? "\u001b[B" : "\u001b[A");
      expect(render()).toBe(normalHeight);
    }
    selector.handleInput("\t");
    expect(render()).toBe(normalHeight);
    selector.handleInput("a");
    expect(render()).toBeLessThan(normalHeight);
    selector.handleInput("m");
    selector.handleInput("\r");
    expect(render()).toBe(normalHeight);
    selector.handleInput("s");
    const reviewHeight = render();
    expect(render()).toBe(reviewHeight);
    selector.handleInput("\u001b");
    expect(render()).toBe(normalHeight);
    selector.handleInput("\u001b");
    const exitHeight = render();
    expect(render()).toBe(exitHeight);
  });
});
