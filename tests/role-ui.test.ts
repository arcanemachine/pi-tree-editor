import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installNativeHooks } from "../src/native/internal-imports.js";
import {
  clearSessionState,
  selectorState,
  setActiveMode,
  setExtensionContext,
} from "../src/native/patch-state.js";

afterEach(() => clearSessionState());

async function selectorFor(model = true) {
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
    role: "user",
    content: "anchor",
    timestamp: 1,
  });
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
