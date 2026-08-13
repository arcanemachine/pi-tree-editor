import { planSurgery } from "../surgery/planner.js";
import { applySurgery } from "../surgery/replay.js";
import { activePath } from "../surgery/active-path.js";
import {
  buildLogicalUnits,
  editableTextBlocks,
} from "../surgery/logical-units.js";
import {
  Container,
  getKeybindings,
  Input,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import * as PiTui from "@earendil-works/pi-tui";
import type { SessionEntryLike } from "../surgery/types.js";
import type { SessionManagerAdapter } from "../surgery/replay.js";
import {
  getActiveMode,
  getExtensionContext,
  getHookStatus,
  selectorState,
  reportHookFailure,
  setHookStatus,
} from "./patch-state.js";

const PATCHED = Symbol.for("arcanemachine.pi-tree-editor.selector-patched");
const SELECTOR_RENDER_PATCHED = Symbol.for(
  "arcanemachine.pi-tree-editor.selector-render-patched",
);
const HELP_RENDER_PATCHED = Symbol.for(
  "arcanemachine.pi-tree-editor.help-render-patched",
);

type SelectorLike = {
  getTreeList?: () => Record<string | symbol, unknown>;
  [key: string | symbol]: unknown;
};

type TreeListLike = {
  getSelectedNode?: () => { entry: SessionEntryLike } | undefined;
  render?: (width: number) => string[];
  onCancel?: () => void;
  [key: string | symbol]: unknown;
};

export function patchTreeSelector(module: Record<string, unknown>): boolean {
  const component = module.TreeSelectorComponent as
    | { prototype?: SelectorLike }
    | undefined;
  const prototype = component?.prototype;
  if (!prototype || prototype[PATCHED]) return Boolean(prototype?.[PATCHED]);
  const originalHandleInput = prototype.handleInput;
  const originalGetTreeList = prototype.getTreeList;
  if (
    typeof originalHandleInput !== "function" ||
    typeof originalGetTreeList !== "function"
  ) {
    reportHookFailure("Tree selector methods are unavailable");
    return false;
  }

  const getList = function (this: SelectorLike): TreeListLike {
    return originalGetTreeList.call(this) as TreeListLike;
  };
  prototype.getTreeList = getList;
  patchSelectorRender(prototype);
  prototype.handleInput = function (this: SelectorLike, keyData: string): void {
    if (!getHookStatus().enabled) {
      originalHandleInput.call(this, keyData);
      return;
    }
    const state = selectorState(this);
    if (state.flowComponent) {
      state.flowComponent.handleInput(keyData);
      return;
    }
    if (state.inlineInput) {
      if (keyData === "\u001b") {
        state.inlineInput.cancel();
      } else if (isPlainInlineSubmit(keyData)) {
        state.inlineInput.submit();
      } else {
        state.inlineInput.input.handleInput(keyData);
      }
      return;
    }
    if (keyData === "\t") {
      const ctx = getExtensionContext();
      if (state.editMode && state.operations.length > 0) {
        ctx?.ui.notify(
          "Save with S or discard with Escape before leaving edit mode",
          "info",
        );
        return;
      }
      state.editMode = !state.editMode;
      ctx?.ui.notify(
        state.editMode
          ? "Tree editor mode: S save, E edit, D remove, A after, Shift+A before, U undo"
          : "Tree editor mode off",
        "info",
      );
      return;
    }
    if (!state.editMode) {
      originalHandleInput.call(this, keyData);
      return;
    }
    if (state.busy) return;
    const list = this.getTreeList?.() as TreeListLike | undefined;
    const selected = list?.getSelectedNode?.();
    if (keyData === "\u001b") {
      if (state.operations.length === 0) {
        state.editMode = false;
        state.snapshot = undefined;
        list?.onCancel?.();
      } else {
        showExitConfirmation(this, state, list);
      }
      return;
    }
    if (keyData === "u" || keyData === "U") {
      state.operations.pop();
      if (state.operations.length === 0) state.snapshot = undefined;
      getExtensionContext()?.ui.notify("Undid latest staged tree edit", "info");
      return;
    }
    if (keyData === "d" || keyData === "D") {
      if (!selected) return;
      if (!isActivePathEntry(selected.entry.id)) return;
      toggleRemoval(state, selected.entry.id);
      return;
    }
    if (keyData === "a" || keyData === "A") {
      if (!selected) return;
      if (!isActivePathEntry(selected.entry.id)) return;
      void insertNote(
        this,
        state,
        selected.entry.id,
        keyData === "A" ? "before" : "after",
        list,
      );
      return;
    }
    if (keyData === "e" || keyData === "E") {
      if (!selected) return;
      if (!isActivePathEntry(selected.entry.id)) return;
      void editEntry(this, state, selected.entry, list);
      return;
    }
    if (keyData === "s" || keyData === "S") {
      if (state.operations.length === 0) {
        getExtensionContext()?.ui.notify(
          "No staged tree edits to save",
          "info",
        );
        return;
      }
      showSaveReview(this, state, list);
      return;
    }
    if (keyData === "\r" || keyData === "\n") {
      getExtensionContext()?.ui.notify(
        state.operations.length > 0
          ? "Use S to save staged tree edits"
          : "No staged tree edits",
        "info",
      );
      return;
    }
    if (
      keyData.includes("13;5u") ||
      keyData.includes("27;5;13") ||
      keyData.includes("13;5~")
    ) {
      if (state.operations.length === 0) {
        getExtensionContext()?.ui.notify("No staged tree edits", "info");
        return;
      }
      showSaveReview(this, state, list);
      return;
    }
    // Keep navigation, filtering, folding, copying, and label editing native.
    originalHandleInput.call(this, keyData);
  };
  prototype[PATCHED] = true;
  setHookStatus({ enabled: true, installedAt: new Date().toISOString() });
  return true;
}

function patchSelectorRender(prototype: SelectorLike): void {
  if (prototype[SELECTOR_RENDER_PATCHED]) return;
  const inherited = Object.getPrototypeOf(prototype) as
    | { render?: (width: number) => string[] }
    | undefined;
  const originalRender = prototype.render ?? inherited?.render;
  if (typeof originalRender !== "function") return;
  prototype.render = function (this: SelectorLike, width: number): string[] {
    if (!getHookStatus().enabled) return originalRender.call(this, width);
    patchSelectorHelp(this);
    return originalRender.call(this, width);
  };
  prototype[SELECTOR_RENDER_PATCHED] = true;
}

function isPlainInlineSubmit(keyData: string): boolean {
  const keybindings = getKeybindings();
  return (
    keybindings.matches(keyData, "tui.input.submit") &&
    !keybindings.matches(keyData, "tui.input.newLine")
  );
}

function patchSelectorHelp(selector: SelectorLike): void {
  const children = selector.children;
  if (!Array.isArray(children)) return;
  const help = children.find((child) => {
    if (!child || typeof child !== "object") return false;
    const candidate = child as Record<string | symbol, unknown>;
    if (
      candidate[HELP_RENDER_PATCHED] ||
      typeof candidate.render !== "function"
    ) {
      return false;
    }
    return (
      (child as { constructor?: { name?: string } }).constructor?.name ===
      "TreeHelp"
    );
  }) as Record<string | symbol, unknown> | undefined;
  if (!help || typeof help.render !== "function") return;
  const originalRender = help.render as (width: number) => string[];
  help.render = function (this: object, width: number): string[] {
    if (!getHookStatus().enabled) return originalRender.call(this, width);
    const native = originalRender.call(this, width);
    if (native.length === 0) return native;
    return [editorHelpLine(selectorState(selector), width), ...native.slice(1)];
  };
  help[HELP_RENDER_PATCHED] = true;
}

function editorHelpLine(
  state: ReturnType<typeof selectorState>,
  width: number,
): string {
  const line = state.inlineInput
    ? "Tree editor input: Enter stage change · Escape cancel input"
    : state.flow === "save-review"
      ? "Tree editor save: Yes apply · Cancel keep staged"
      : state.flow === "exit-confirm"
        ? "Exit tree: Cancel keep editing · Yes apply · No discard"
        : state.editMode
          ? "Tree editor ON: S save · E edit · D remove · A/Shift+A insert · U undo"
          : "Tree editor: Tab edit mode · Escape exit /tree";
  return truncateToWidth(`  ${line}`, Math.max(1, width));
}

function getManager(): Record<string, any> | undefined {
  const mode = getActiveMode();
  const manager = mode?.sessionManager;
  if (manager && typeof manager === "object")
    return manager as Record<string, any>;
  const ctx = getExtensionContext();
  return ctx?.sessionManager as Record<string, any> | undefined;
}

function snapshotIfNeeded(state: ReturnType<typeof selectorState>): void {
  if (state.snapshot) return;
  const manager = getManager();
  if (!manager) return;
  state.snapshot = {
    sessionId:
      typeof manager.getSessionId === "function"
        ? String(manager.getSessionId())
        : undefined,
    leafId: manager.getLeafId(),
    entries: structuredClone(manager.getEntries()),
  };
}

function isActivePathEntry(entryId: string): boolean {
  const manager = getManager();
  if (!manager) return false;
  const onPath = activePath(manager.getEntries(), manager.getLeafId()).some(
    (entry) => entry.id === entryId,
  );
  if (!onPath) {
    getExtensionContext()?.ui.notify(
      "Only entries on the active branch can be edited",
      "warning",
    );
  }
  return onPath;
}

function toggleRemoval(
  state: ReturnType<typeof selectorState>,
  entryId: string,
): void {
  snapshotIfNeeded(state);
  const manager = getManager();
  const path = manager
    ? activePath(manager.getEntries(), manager.getLeafId())
    : [];
  const unit = buildLogicalUnits(path).units.find((candidate) =>
    candidate.entryIds.includes(entryId),
  );
  const unitId = unit?.id ?? entryId;
  const existing = state.operations.findIndex(
    (operation) =>
      operation.kind === "remove-unit" && operation.unitId === unitId,
  );
  if (existing >= 0) state.operations.splice(existing, 1);
  else state.operations.push({ kind: "remove-unit", unitId });
}

async function insertNote(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  anchorEntryId: string,
  position: "before" | "after",
  list: TreeListLike | undefined,
): Promise<void> {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  startInlineEdit(
    selector,
    state,
    "",
    (text) => {
      if (!text.trim()) {
        ctx.ui.notify("Inserted context notes cannot be empty", "warning");
        return false;
      }
      snapshotIfNeeded(state);
      state.operations.push({
        kind: "insert-note",
        anchorUnitId: anchorEntryId,
        position,
        text,
      });
      ctx.ui.notify("Context note staged", "info");
      return true;
    },
    list,
  );
}

async function editEntry(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  list: TreeListLike | undefined,
): Promise<void> {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  const blocks = editableTextBlocks(entry);
  if (blocks.length === 0) {
    ctx.ui.notify("This tree entry has no editable text block", "warning");
    return;
  }
  const startBlock = (block: (typeof blocks)[number]) => {
    startInlineEdit(
      selector,
      state,
      block.text,
      (text) => {
        snapshotIfNeeded(state);
        state.operations.push({
          kind: "edit-text",
          entryId: entry.id,
          blockIndex: block.blockIndex,
          text,
        });
        ctx.ui.notify("Conversation edit staged", "info");
        return true;
      },
      list,
    );
  };
  if (blocks.length > 1) {
    state.flow = "block-choice";
    showFlowComponent(
      selector,
      state,
      [
        "Choose a text block to edit",
        ...blocks.map(
          (candidate, index) => `${index + 1}: ${candidate.text.slice(0, 70)}`,
        ),
        "Press 1-9 to choose · Escape back to the tree",
      ],
      (data) => {
        const selectedIndex = Number.parseInt(data, 10) - 1;
        const block = Number.isInteger(selectedIndex)
          ? blocks[selectedIndex]
          : undefined;
        if (!block) return;
        state.flowComponent?.finish();
        startBlock(block);
      },
      () => undefined,
      () => undefined,
    );
    return;
  }
  startBlock(blocks[0]!);
}

function showFlowComponent(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  lines: string[],
  onInput: (data: string) => void,
  onFinish: () => void,
  onCancel: () => void = onFinish,
): void {
  const labelInputContainer = selector.labelInputContainer as
    | { clear(): void; addChild(child: unknown): void }
    | undefined;
  const treeContainer = selector.treeContainer as
    | { clear(): void; addChild(child: unknown): void }
    | undefined;
  const list = selector.getTreeList?.() as TreeListLike | undefined;
  if (!labelInputContainer || !treeContainer || !list) return;
  const container = new Container();
  container.addChild(new Text(lines.join("\n"), 1, 0));
  const finish = () => {
    state.flow = undefined;
    state.flowComponent = undefined;
    state.confirmingExit = false;
    labelInputContainer.clear();
    treeContainer.clear();
    treeContainer.addChild(list);
    onFinish();
  };
  state.flowComponent = {
    handleInput: onInput,
    finish,
    cancel: () => {
      state.flow = undefined;
      state.flowComponent = undefined;
      state.confirmingExit = false;
      labelInputContainer.clear();
      treeContainer.clear();
      treeContainer.addChild(list);
      onCancel();
    },
  };
  treeContainer.clear();
  labelInputContainer.clear();
  labelInputContainer.addChild(container);
}

type ChoiceItem = { value: string; label: string };

type ChoiceFlow = "save-review" | "exit-confirm";

const choiceTheme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
};

function showChoiceMenu(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  list: TreeListLike | undefined,
  flow: ChoiceFlow,
  heading: string,
  items: ChoiceItem[],
  defaultIndex: number,
  onSelect: (value: string) => void,
  onCancel: () => void,
): boolean {
  const labelInputContainer = selector.labelInputContainer as
    | { clear(): void; addChild(child: unknown): void }
    | undefined;
  const treeContainer = selector.treeContainer as
    | { clear(): void; addChild(child: unknown): void }
    | undefined;
  const SelectListComponent = (
    PiTui as unknown as {
      SelectList?: new (
        items: ChoiceItem[],
        maxVisible: number,
        theme: typeof choiceTheme,
      ) => {
        onSelect?: (item: ChoiceItem) => void;
        onCancel?: () => void;
        setSelectedIndex(index: number): void;
        handleInput(data: string): void;
        render(width: number): string[];
        invalidate?(): void;
      };
    }
  ).SelectList;
  const listForMenu = list;
  if (!labelInputContainer || !treeContainer || !listForMenu) return false;
  if (typeof SelectListComponent !== "function") {
    getExtensionContext()?.ui.notify(
      "Tree editor confirmation menus are unavailable in this Pi build",
      "warning",
    );
    return false;
  }

  const headingText = new Text(heading, 0, 0);
  const select = new SelectListComponent(items, items.length, choiceTheme);
  select.setSelectedIndex(defaultIndex);
  const menu = {
    render(width: number): string[] {
      return [...headingText.render(width), ...select.render(width)].map(
        (line) => truncateToWidth(line, Math.max(1, width), ""),
      );
    },
    invalidate(): void {
      headingText.invalidate();
      select.invalidate?.();
    },
  };
  const finish = () => {
    state.flow = undefined;
    state.flowComponent = undefined;
    state.confirmingExit = false;
    labelInputContainer.clear();
    treeContainer.clear();
    treeContainer.addChild(listForMenu);
  };
  const cancel = () => {
    finish();
    onCancel();
  };
  select.onSelect = (item) => {
    finish();
    onSelect(item.value);
  };
  select.onCancel = cancel;
  state.flow = flow;
  state.flowComponent = {
    handleInput: (data) => select.handleInput(data),
    finish,
    cancel,
  };
  treeContainer.clear();
  labelInputContainer.clear();
  labelInputContainer.addChild(menu);
  return true;
}

function showExitConfirmation(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  list: TreeListLike | undefined,
): void {
  const ctx = getExtensionContext();
  if (!ctx) return;
  state.confirmingExit = true;
  const shown = showChoiceMenu(
    selector,
    state,
    list,
    "exit-confirm",
    `Exit tree with ${state.operations.length} staged item${state.operations.length === 1 ? "" : "s"}?`,
    [
      { value: "cancel", label: "Cancel" },
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    0,
    (value) => {
      if (value === "yes") {
        void previewAndApply(selector, state, list, true);
      } else if (value === "no") {
        state.operations = [];
        state.snapshot = undefined;
        state.editMode = false;
        list?.onCancel?.();
        ctx.ui.notify("Staged changes discarded", "info");
      }
    },
    () => {
      ctx.ui.notify("Kept editing; staged changes were not discarded", "info");
    },
  );
  if (!shown) state.confirmingExit = false;
}

function showSaveReview(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  list: TreeListLike | undefined,
): void {
  const ctx = getExtensionContext();
  if (!ctx || !state.snapshot) return;
  try {
    planSurgery({
      entries: state.snapshot.entries,
      leafId: state.snapshot.leafId,
      sessionId: state.snapshot.sessionId,
      operations: state.operations,
    });
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }
  showChoiceMenu(
    selector,
    state,
    list,
    "save-review",
    `Save ${state.operations.length} staged item${state.operations.length === 1 ? "" : "s"}?`,
    [
      { value: "yes", label: "Yes" },
      { value: "cancel", label: "Cancel" },
    ],
    0,
    (value) => {
      if (value === "yes") {
        void previewAndApply(selector, state, list, true);
      }
    },
    () => {
      ctx.ui.notify("Save canceled; staged changes were kept", "info");
    },
  );
}

type MultilineEditorLike = {
  focused: boolean;
  onSubmit?: (text: string) => void;
  setText(text: string): void;
  getText(): string;
  handleInput(data: string): void;
  render(width: number): string[];
};

function createMultilineEditor(
  prefill: string,
): MultilineEditorLike | undefined {
  const tui = getActiveMode()?.ui;
  if (!tui || typeof tui !== "object") return undefined;
  try {
    const terminal = (tui as Record<string, any>).terminal;
    if (!terminal || typeof terminal.rows !== "number") return undefined;
    const EditorComponent = (
      PiTui as unknown as {
        Editor?: new (tui: any, theme: any) => MultilineEditorLike;
      }
    ).Editor;
    if (!EditorComponent) return undefined;
    const editor = new EditorComponent(tui as any, {
      borderColor: (text: string) => text,
      selectList: {
        selectedPrefix: (text: string) => text,
        selectedText: (text: string) => text,
        description: (text: string) => text,
        scrollInfo: (text: string) => text,
        noMatch: (text: string) => text,
      },
    });
    editor.setText(prefill);
    return editor;
  } catch {
    return undefined;
  }
}

function startInlineEdit(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  prefill: string,
  onSubmit: (text: string) => boolean,
  list: TreeListLike | undefined,
): void {
  const labelInputContainer = selector.labelInputContainer as
    | { clear(): void; addChild(child: unknown): void }
    | undefined;
  const treeContainer = selector.treeContainer as
    | { clear(): void; addChild(child: unknown): void }
    | undefined;
  if (!labelInputContainer || !treeContainer) {
    getExtensionContext()?.ui.notify(
      "Inline tree editing is unavailable in this Pi build",
      "warning",
    );
    return;
  }
  const input = /[\r\n]/.test(prefill)
    ? createMultilineEditor(prefill)
    : new Input();
  if (!input) {
    getExtensionContext()?.ui.notify(
      "Multiline inline tree editing is unavailable in this Pi build",
      "warning",
    );
    return;
  }
  if (input instanceof Input) input.setValue(prefill);
  const isMultilineEditor = !(input instanceof Input);
  const initialEditorText = isMultilineEditor
    ? (input as MultilineEditorLike).getText()
    : undefined;
  input.focused = Boolean(selector.focused);
  const finish = () => {
    state.inlineInput = undefined;
    labelInputContainer.clear();
    treeContainer.clear();
    if (list) treeContainer.addChild(list);
    getExtensionContext()?.ui.notify("Inline tree input closed", "info");
  };
  const submittedValue = (value: string): string =>
    isMultilineEditor && value === initialEditorText ? prefill : value;
  const submit = (value: string) => {
    if (onSubmit(submittedValue(value))) finish();
  };
  const submitInline = () => {
    const value = isMultilineEditor
      ? (input as MultilineEditorLike).getText()
      : (input as Input).getValue();
    submit(value);
  };
  input.onSubmit = submit;
  if (input instanceof Input) input.onEscape = finish;
  state.inlineInput = { input, finish, cancel: finish, submit: submitInline };
  treeContainer.clear();
  labelInputContainer.clear();
  labelInputContainer.addChild(input);
}

async function previewAndApply(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  list: TreeListLike | undefined,
  approved = false,
): Promise<void> {
  const ctx = getExtensionContext();
  const mode = getActiveMode();
  const manager = getManager();
  if (!ctx || !manager || !state.snapshot) return;
  state.busy = true;
  try {
    if (!ctx.isIdle()) {
      ctx.ui.notify(
        "Wait for the current response to finish before editing",
        "warning",
      );
      return;
    }
    const plan = planSurgery({
      entries: state.snapshot.entries,
      leafId: state.snapshot.leafId,
      sessionId: state.snapshot.sessionId,
      operations: state.operations,
    });
    if (!approved) return;
    const session = mode?.session as
      | { navigateTree?: (id: string, options?: unknown) => Promise<unknown> }
      | undefined;
    const result = await applySurgery(
      manager as SessionManagerAdapter,
      plan,
      session?.navigateTree ? (session as any) : undefined,
    );
    state.operations = [];
    state.snapshot = undefined;
    state.editMode = false;
    list?.onCancel?.();
    const interactive = mode as Record<string, any> | undefined;
    interactive?.chatContainer?.clear?.();
    interactive?.renderInitialMessages?.();
    interactive?.showStatus?.("Applied copy-on-write tree edits");
    interactive?.ui?.requestRender?.();
    ctx.ui.notify(`Tree edits applied (${result.auditEntryId})`, "info");
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  } finally {
    state.busy = false;
  }
}

export function activePathForEditor(): SessionEntryLike[] | undefined {
  const manager = getManager();
  if (!manager) return undefined;
  return activePath(manager.getEntries(), manager.getLeafId());
}
