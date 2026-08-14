import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installNativeHooks } from "../src/native/internal-imports.js";
import {
  clearSessionState,
  selectorState,
  setActiveMode,
  setExtensionContext,
} from "../src/native/patch-state.js";

afterEach(() => clearSessionState());

async function selectorFor(
  model = true,
  message: Record<string, unknown> = { role: "user", content: "anchor" },
) {
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
  const manager = SessionManager.inMemory("/tmp/pi-tree-editor-role-ui-test");
  const leafId = manager.appendMessage({
    ...message,
    timestamp: 1,
  } as never);
  setActiveMode({
    sessionManager: manager,
    session: model
      ? { model: { api: "openai", provider: "openai", id: "test" } }
      : {},
    ui: { terminal: { rows: 40 }, requestRender: () => undefined },
  } as never);
  setExtensionContext({
    hasUI: true,
    isIdle: () => true,
    ui: { notify: () => undefined },
  } as never);
  const selector = new TreeSelectorComponent(
    manager.getTree(),
    leafId,
    30,
    () => undefined,
    () => undefined,
  );
  return { manager, leafId, selector };
}

function setInlineText(selector: object, text: string): void {
  const input = selectorState(selector).inlineInput?.input as unknown as {
    setText?: (value: string) => void;
    setValue?: (value: string) => void;
  };
  if (input.setText) input.setText(text);
  else input.setValue?.(text);
}

describe("role-based staged rows", () => {
  it("opens the role menu in order and supports an actual virtual row", async () => {
    const { manager, selector } = await selectorFor();
    selector.handleInput("\t");
    selector.handleInput("a");
    const roleMenu = selector.render(80).join("\n");
    expect(roleMenu).toContain("User");
    expect(roleMenu).toContain("Assistant");
    expect(roleMenu).toContain("Context note");
    expect(roleMenu.indexOf("User")).toBeLessThan(
      roleMenu.indexOf("Assistant"),
    );
    selector.handleInput("\r");
    expect(selectorState(selector).inlineInput).toBeDefined();
    setInlineText(selector, "inserted user");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toMatchObject([
      {
        kind: "insert",
        role: "user",
        text: "inserted user",
        position: "after",
      },
    ]);
    expect(selector.render(80).join("\n")).toContain("[insert user]");
    selector.handleInput("\u001b[B");
    selector.handleInput("e");
    setInlineText(selector, "edited virtual user");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toMatchObject([
      { kind: "insert", text: "edited virtual user" },
    ]);
    selector.handleInput("u");
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(manager.getEntries()).toHaveLength(1);
  });

  it("keeps canonical assistant virtual rows role-correct and bounded", async () => {
    const { selector } = await selectorFor();
    selector.handleInput("\t");
    selector.handleInput("a");
    selector.handleInput("\u001b[B");
    selector.handleInput("\r");
    setInlineText(selector, "virtual assistant");
    selector.handleInput("\r");
    for (const width of [80, 32, 12]) {
      expect(
        selector
          .render(width)
          .every((line: string) => visibleWidth(line) <= width),
      ).toBe(true);
    }
    selector.handleInput("\u001b[B");
    const selected = selector.getTreeList().getSelectedNode();
    expect(selected?.entry.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "virtual assistant" }],
    });
  });

  it("uses ctrl+s only and fails closed for an unavailable assistant model", async () => {
    const { selector } = await selectorFor(false);
    selector.handleInput("\t");
    selector.handleInput("a");
    selector.handleInput("\u001b[B");
    selector.handleInput("\r");
    expect(selector.render(80).join("\n")).not.toContain("Tree editor input");
    expect(selectorState(selector).inlineInput).toBeUndefined();

    const { selector: saveSelector } = await selectorFor();
    saveSelector.handleInput("\t");
    saveSelector.handleInput("a");
    saveSelector.handleInput("\r");
    setInlineText(saveSelector, "inserted");
    saveSelector.handleInput("\r");
    saveSelector.handleInput("s");
    expect(selectorState(saveSelector).flow).toBeUndefined();
    saveSelector.handleInput("\u0013");
    expect(selectorState(saveSelector).flow).toBe("save-review");
  });

  it("offers the exact provider-signed answer override and stages an unsigned copy", async () => {
    const { selector } = await selectorFor(true, {
      role: "assistant",
      content: [{ type: "text", text: "signed answer", textSignature: "sig" }],
      api: "openai",
      provider: "openai",
      model: "test",
    });
    selector.handleInput("\t");
    selector.handleInput("e");
    expect(selectorState(selector).flow).toBe("signed-override");
    const menu = selector.render(100).join("\n");
    expect(menu).toContain(
      "This block is provider-signed and cannot be edited safely. Edit it anyways?",
    );
    expect(menu).toContain("→ No. Return to tree");
    expect(menu).toContain("  Yes. Create an unsigned editable copy");
    selector.handleInput("\u001b");
    expect(selectorState(selector).operations).toHaveLength(0);

    selector.handleInput("e");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toHaveLength(0);
    selector.handleInput("e");
    selector.handleInput("\u001b[B");
    selector.handleInput("\r");
    setInlineText(selector, "signed answer");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toEqual([
      {
        kind: "edit-unsigned",
        entryId: selector.getTreeList().getSelectedNode().entry.id,
        blockIndex: 0,
        blockType: "text",
        text: "signed answer",
      },
    ]);
    expect(selector.render(100).join("\n")).toContain("[edit unsigned]");
    selector.handleInput("u");
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(selector.render(100).join("\n")).not.toContain("[edit unsigned]");
  });

  it("keeps unsigned answer editing safe while unsigned reasoning stays read-only", async () => {
    const { selector, manager, leafId } = await selectorFor(true, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "unsigned thought" },
        { type: "text", text: "answer" },
        {
          type: "text",
          text: "signed answer",
          textSignature: "sig",
        },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
    });
    const original = structuredClone(manager.getEntries());
    selector.handleInput("\t");
    selector.handleInput("e");
    expect(selector.render(100).join("\n")).toContain(
      "1: Answer text — answer",
    );
    selector.handleInput("1");
    setInlineText(selector, "changed answer");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toEqual([
      {
        kind: "edit-text",
        entryId: leafId,
        blockIndex: 1,
        text: "changed answer",
      },
    ]);
    expect(selector.render(100).join("\n")).toContain("[edit]");
    expect(selector.render(100).join("\n")).not.toContain("[edit unsigned]");
    expect(manager.getEntries()).toEqual(original);

    selector.handleInput("u");
    selector.handleInput("e");
    expect(selector.render(100).join("\n")).toContain(
      "3: Reasoning — unsigned thought (read-only: provider-signed)",
    );
    selector.handleInput("3");
    expect(selectorState(selector).operations).toHaveLength(0);
    expect(selectorState(selector).flow).toBeUndefined();
  });

  it("allows an unsigned answer beside signed reasoning", async () => {
    const { selector, leafId } = await selectorFor(true, {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        {
          type: "thinking",
          thinking: "signed thought",
          thinkingSignature: "sig",
        },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
    });
    selector.handleInput("\t");
    selector.handleInput("e");
    selector.handleInput("1");
    setInlineText(selector, "changed answer");
    selector.handleInput("\r");
    expect(selectorState(selector).operations).toEqual([
      {
        kind: "edit-text",
        entryId: leafId,
        blockIndex: 0,
        text: "changed answer",
      },
    ]);
    expect(selector.render(100).join("\n")).toContain("[edit]");
    expect(selector.render(100).join("\n")).not.toContain("[edit unsigned]");
  });

  it("offers the same unsigned-copy menu for directly signed reasoning", async () => {
    const { selector } = await selectorFor(true, {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "signed thought",
          thinkingSignature: "sig",
        },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
    });
    selector.handleInput("\t");
    selector.handleInput("e");
    expect(selectorState(selector).flow).toBe("signed-override");
    expect(selector.render(100).join("\n")).toContain(
      "This block is provider-signed and cannot be edited safely. Edit it anyways?",
    );
    selector.handleInput("\u001b[B");
    selector.handleInput("\r");
    setInlineText(selector, "new thought");
    selector.handleInput("\r");
    expect(selectorState(selector).operations[0]).toMatchObject({
      kind: "edit-unsigned",
      blockType: "thinking",
      text: "new thought",
    });
    expect(selector.render(100).join("\n")).toContain(
      "[edit reasoning unsigned]",
    );
  });

  it("cancels role and numbered block choosers with Escape", async () => {
    const { selector } = await selectorFor();
    selector.handleInput("\t");
    selector.handleInput("a");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(0);

    const assistant = selector.getTreeList().getSelectedNode().entry;
    assistant.message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thought" },
        { type: "text", text: "answer" },
      ],
      api: "openai",
      provider: "openai",
      model: "test",
    };
    selector.handleInput("e");
    expect(selectorState(selector).flow).toBe("block-choice");
    selector.handleInput("\u001b");
    expect(selectorState(selector).flow).toBeUndefined();
    expect(selectorState(selector).operations).toHaveLength(0);
  });
});
