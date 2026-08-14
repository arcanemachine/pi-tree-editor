import { planSurgery } from "../surgery/planner.js";
import { applySurgery } from "../surgery/replay.js";
import { activePath } from "../surgery/active-path.js";
import {
  buildLogicalUnits,
  editableTextBlocks,
  reasoningBlocks,
  reasoningEligibility,
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
  getEntryDisplayText?: (node: unknown, isSelected: boolean) => string;
  render?: (width: number) => string[];
  onCancel?: () => void;
  [key: string | symbol]: unknown;
};

type DisplayTheme = {
  fg(color: string, text: string): string;
};

const TREE_LIST_DISPLAY_PATCHED = Symbol.for(
  "arcanemachine.pi-tree-editor.tree-list-display-patched",
);

export function patchTreeSelector(
  module: Record<string, unknown>,
  theme?: unknown,
): boolean {
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
  patchSelectorRender(prototype, getDisplayTheme(theme));
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
          "Save with s or discard with Escape before leaving edit mode",
          "info",
        );
        return;
      }
      state.editMode = !state.editMode;
      ctx?.ui.notify(
        state.editMode
          ? "Tree editor mode: s save, e edit, d remove, a after, Shift+A before, u unstage"
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
      if (!selected) return;
      unstageSelected(state, selected.entry.id);
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
          ? "Use s to save staged tree edits"
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

function patchSelectorRender(
  prototype: SelectorLike,
  theme: DisplayTheme | undefined,
): void {
  if (prototype[SELECTOR_RENDER_PATCHED]) return;
  const inherited = Object.getPrototypeOf(prototype) as
    | { render?: (width: number) => string[] }
    | undefined;
  const originalRender = prototype.render ?? inherited?.render;
  if (typeof originalRender !== "function") return;
  prototype.render = function (this: SelectorLike, width: number): string[] {
    if (!getHookStatus().enabled) return originalRender.call(this, width);
    patchSelectorHelp(this);
    patchTreeListDisplay(this, selectorState(this), theme);
    return originalRender.call(this, width);
  };
  prototype[SELECTOR_RENDER_PATCHED] = true;
}

function getDisplayTheme(value: unknown): DisplayTheme | undefined {
  return value && typeof value === "object"
    ? (value as DisplayTheme)
    : undefined;
}

function patchTreeListDisplay(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  theme: DisplayTheme | undefined,
): void {
  if (!theme) return;
  try {
    if (typeof theme.fg !== "function") return;
  } catch {
    return;
  }
  const list = selector.getTreeList?.() as TreeListLike | undefined;
  if (!list || list[TREE_LIST_DISPLAY_PATCHED]) return;
  const original = list.getEntryDisplayText;
  if (typeof original !== "function") return;
  list.getEntryDisplayText = function (
    this: TreeListLike,
    node: unknown,
    isSelected: boolean,
  ): string {
    if (!getHookStatus().enabled) return original.call(this, node, isSelected);
    const entry = getDisplayEntry(node);
    if (!entry) return original.call(this, node, isSelected);
    try {
      const display = displayAnnotations(entry, state, theme);
      const displayNode =
        display.edits.length > 0 || display.reasoningEdits.length > 0
          ? cloneDisplayNode(node, entry, display.edits, display.reasoningEdits)
          : node;
      const rendered = original.call(this, displayNode, isSelected);
      return `${display.reasoningPreview}${display.marker}${rendered}`;
    } catch {
      return original.call(this, node, isSelected);
    }
  };
  list[TREE_LIST_DISPLAY_PATCHED] = true;
}

type DisplayAnnotations = {
  edits: Array<{ text: string; blockIndex?: number }>;
  reasoningEdits: Array<{ thinking: string; blockIndex: number }>;
  reasoningPreview: string;
  marker: string;
};

function getDisplayEntry(node: unknown): SessionEntryLike | undefined {
  if (!node || typeof node !== "object") return undefined;
  const entry = (node as { entry?: unknown }).entry;
  return entry && typeof entry === "object"
    ? (entry as SessionEntryLike)
    : undefined;
}

function cloneDisplayNode(
  node: unknown,
  entry: SessionEntryLike,
  edits: Array<{ text: string; blockIndex?: number }>,
  reasoningEdits: Array<{ thinking: string; blockIndex: number }>,
): unknown {
  const clonedEntry = structuredClone(entry) as SessionEntryLike;
  for (const edit of edits) {
    applyDisplayEdit(clonedEntry, edit.text, edit.blockIndex);
  }
  for (const edit of reasoningEdits) {
    applyDisplayReasoningEdit(clonedEntry, edit.thinking, edit.blockIndex);
  }
  return { ...(node as Record<string, unknown>), entry: clonedEntry };
}

function applyDisplayEdit(
  entry: SessionEntryLike,
  text: string,
  blockIndex?: number,
): void {
  const blocks = editableTextBlocks(entry);
  const block =
    blocks.find((candidate) => candidate.blockIndex === blockIndex) ??
    blocks[0];
  if (!block) return;
  if (block.path === "summary") {
    entry.summary = text;
    return;
  }
  if (block.path === "message") {
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content;
    if (typeof content === "string") {
      message.content = text;
    } else if (Array.isArray(content)) {
      const candidate = content[block.blockIndex];
      if (candidate && typeof candidate === "object") {
        (candidate as Record<string, unknown>).text = text;
      }
    }
    return;
  }
  const content = entry.content;
  if (typeof content === "string") {
    entry.content = text;
  } else if (Array.isArray(content)) {
    const candidate = content[block.blockIndex];
    if (candidate && typeof candidate === "object") {
      (candidate as Record<string, unknown>).text = text;
    }
  }
}

function applyDisplayReasoningEdit(
  entry: SessionEntryLike,
  thinking: string,
  blockIndex: number,
): void {
  if (
    entry.type !== "message" ||
    !entry.message ||
    typeof entry.message !== "object"
  ) {
    return;
  }
  const message = entry.message as Record<string, unknown>;
  if (!Array.isArray(message.content)) return;
  const content = message.content as unknown[];
  message.content = content.flatMap((block, index) => {
    if (index !== blockIndex || !block || typeof block !== "object") {
      return [block];
    }
    if (thinking.trim().length === 0) return [];
    const next: Record<string, unknown> = {
      ...(block as Record<string, unknown>),
      thinking,
    };
    delete next.thinkingSignature;
    delete next.redacted;
    return [next];
  });
}

function displayAnnotations(
  entry: SessionEntryLike,
  state: ReturnType<typeof selectorState>,
  theme: DisplayTheme,
): DisplayAnnotations {
  const unit = logicalUnitForEntry(entry.id);
  const operation = state.operations.find((candidate) =>
    operationTargetsUnit(candidate, unit, entry.id),
  );
  const edits =
    operation?.kind === "edit-text" && operation.entryId === entry.id
      ? [{ text: operation.text, blockIndex: operation.blockIndex }]
      : [];
  const reasoningEdits =
    operation?.kind === "edit-reasoning" && operation.entryId === entry.id
      ? [{ thinking: operation.thinking, blockIndex: operation.blockIndex }]
      : [];
  const isFirstEntry = (unit?.entryIds[0] ?? entry.id) === entry.id;
  const isLastEntry = (unit?.entryIds.at(-1) ?? entry.id) === entry.id;
  const removed = operation?.kind === "remove-unit";
  const before =
    operation?.kind === "insert-note" &&
    operation.position === "before" &&
    isFirstEntry;
  const after =
    operation?.kind === "insert-note" &&
    operation.position === "after" &&
    isLastEntry;
  const sourcePreview = reasoningEdits[0]
    ? {
        text: reasoningEdits[0].thinking,
        safe: true,
        removed: reasoningEdits[0].thinking.trim().length === 0,
      }
    : reasoningBlocks(entry)[0];
  const previewBlock = sourcePreview
    ? {
        text: sourcePreview.text,
        safe: sourcePreview.safe,
        reason: "reason" in sourcePreview ? sourcePreview.reason : undefined,
        removed: "removed" in sourcePreview && sourcePreview.removed === true,
      }
    : undefined;
  const reasoningPreview = previewBlock
    ? theme.fg(
        "thinkingText",
        previewBlock.removed
          ? "[reasoning: removed] "
          : `[reasoning: ${reasoningPreviewText(previewBlock)}] `,
      )
    : "";
  const markers = [
    removed ? theme.fg("error", "[remove] ") : "",
    edits.length > 0 ? theme.fg("warning", "[edit] ") : "",
    reasoningEdits.length > 0 ? theme.fg("warning", "[edit reasoning] ") : "",
    before ? theme.fg("accent", "[insert before] ") : "",
    after ? theme.fg("accent", "[insert after] ") : "",
  ];
  return {
    edits,
    reasoningEdits,
    reasoningPreview,
    marker: markers.join(""),
  };
}

function reasoningPreviewText(block: {
  text: string;
  safe: boolean;
  reason?: string;
}): string {
  if (!block.safe && block.reason === "redacted") return "redacted";
  const text = block.text.replace(/[\t\r\n]+/g, " ").trim();
  if (!text && !block.safe && block.reason === "provider-signed") {
    return "opaque";
  }
  if (!text) return "empty";
  return text.length > 56 ? `${text.slice(0, 55)}…` : text;
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
        ? "Exit menu: Yes save · No keep editing · No abandon"
        : state.editMode
          ? "Tree editor ON: s save · e edit · d remove · a/Shift+A insert · u unstage"
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

type StagedOperation = ReturnType<typeof selectorState>["operations"][number];

type LogicalUnitLike = ReturnType<typeof buildLogicalUnits>["units"][number];

function logicalUnitForEntry(entryId: string): LogicalUnitLike | undefined {
  const manager = getManager();
  if (!manager) return undefined;
  const path = activePath(manager.getEntries(), manager.getLeafId());
  return buildLogicalUnits(path).units.find((unit) =>
    unit.entryIds.includes(entryId),
  );
}

function operationTargetsUnit(
  operation: StagedOperation,
  unit: LogicalUnitLike | undefined,
  entryId: string,
): boolean {
  const entryIds = unit?.entryIds ?? [entryId];
  if (operation.kind === "edit-text" || operation.kind === "edit-reasoning") {
    return entryIds.includes(operation.entryId);
  }
  const targetId =
    operation.kind === "remove-unit"
      ? operation.unitId
      : operation.anchorUnitId;
  return targetId === (unit?.id ?? entryId) || entryIds.includes(targetId);
}

function replaceOperationForUnit(
  state: ReturnType<typeof selectorState>,
  unit: LogicalUnitLike | undefined,
  entryId: string,
  operation: StagedOperation,
): void {
  state.operations = state.operations.filter(
    (candidate) => !operationTargetsUnit(candidate, unit, entryId),
  );
  state.operations.push(operation);
}

function unstageSelected(
  state: ReturnType<typeof selectorState>,
  entryId: string,
): void {
  const unit = logicalUnitForEntry(entryId);
  const previousCount = state.operations.length;
  state.operations = state.operations.filter(
    (operation) => !operationTargetsUnit(operation, unit, entryId),
  );
  if (state.operations.length === previousCount) {
    getExtensionContext()?.ui.notify(
      "No staged action for the selected tree item",
      "info",
    );
    return;
  }
  if (state.operations.length === 0) state.snapshot = undefined;
  getExtensionContext()?.ui.notify("Selected tree action unstaged", "info");
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
  const existing = state.operations.some(
    (operation) =>
      operation.kind === "remove-unit" &&
      operationTargetsUnit(operation, unit, entryId),
  );
  if (existing) {
    state.operations = state.operations.filter(
      (operation) => !operationTargetsUnit(operation, unit, entryId),
    );
    if (state.operations.length === 0) state.snapshot = undefined;
    getExtensionContext()?.ui.notify("Tree unit removal unstaged", "info");
    return;
  }
  replaceOperationForUnit(state, unit, entryId, {
    kind: "remove-unit",
    unitId,
  });
  getExtensionContext()?.ui.notify("Tree unit removal staged", "info");
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
      const unit = logicalUnitForEntry(anchorEntryId);
      const anchorUnitId = unit?.id ?? anchorEntryId;
      replaceOperationForUnit(state, unit, anchorEntryId, {
        kind: "insert-note",
        anchorUnitId,
        position,
        text,
      });
      ctx.ui.notify("Context note staged", "info");
      return true;
    },
    list,
  );
}

type EditChoice = {
  kind: "text" | "reasoning";
  blockIndex: number;
  text: string;
  safe: boolean;
  label: string;
};

async function editEntry(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  list: TreeListLike | undefined,
): Promise<void> {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  const textBlocks = editableTextBlocks(entry);
  const reasoning = reasoningBlocks(entry);
  const message =
    entry.type === "message" &&
    entry.message &&
    typeof entry.message === "object"
      ? (entry.message as { role?: unknown })
      : undefined;
  const isAssistant = message?.role === "assistant";
  const eligibility = isAssistant ? reasoningEligibility(entry) : undefined;
  const messageSafe = !isAssistant || eligibility?.eligible === true;
  const choices: EditChoice[] = [
    ...textBlocks.map((block) => ({
      kind: "text" as const,
      blockIndex: block.blockIndex,
      text: block.text,
      safe: messageSafe,
      label: `Answer text — ${previewChoiceText(block.text)}`,
    })),
    ...reasoning.map((block) => ({
      kind: "reasoning" as const,
      blockIndex: block.blockIndex,
      text: block.text,
      safe: block.safe && messageSafe,
      label:
        block.safe && messageSafe
          ? `Reasoning — ${previewChoiceText(block.text)}`
          : `Reasoning — read-only (${eligibility?.reason ?? block.reason ?? "unsupported"})`,
    })),
  ];
  if (choices.length === 0) {
    ctx.ui.notify(
      "This tree entry has no editable text or reasoning block",
      "warning",
    );
    return;
  }
  const startChoice = (choice: EditChoice) => {
    if (!choice.safe) {
      ctx.ui.notify(
        `This entry is read-only (${eligibility?.reason ?? "unsupported"})`,
        "warning",
      );
      return;
    }
    const unit = logicalUnitForEntry(entry.id);
    const existing = state.operations.find((operation) =>
      operationTargetsUnit(operation, unit, entry.id),
    );
    const prefill =
      choice.kind === "text" &&
      existing?.kind === "edit-text" &&
      existing.entryId === entry.id &&
      (existing.blockIndex ?? 0) === choice.blockIndex
        ? existing.text
        : choice.kind === "reasoning" &&
            existing?.kind === "edit-reasoning" &&
            existing.entryId === entry.id &&
            existing.blockIndex === choice.blockIndex
          ? existing.thinking
          : choice.text;
    startInlineEdit(
      selector,
      state,
      prefill,
      (text) => {
        snapshotIfNeeded(state);
        if (choice.kind === "reasoning") {
          if (
            text.trim().length === 0 &&
            isSoleReasoningBlock(entry, choice.blockIndex)
          ) {
            ctx.ui.notify(
              "Cannot remove the only content block from an assistant entry",
              "warning",
            );
            return false;
          }
          replaceOperationForUnit(state, unit, entry.id, {
            kind: "edit-reasoning",
            entryId: entry.id,
            blockIndex: choice.blockIndex,
            thinking: text,
          });
          ctx.ui.notify(
            text.trim().length === 0
              ? "Reasoning block removal staged"
              : "Reasoning edit staged",
            "info",
          );
        } else {
          replaceOperationForUnit(state, unit, entry.id, {
            kind: "edit-text",
            entryId: entry.id,
            blockIndex: choice.blockIndex,
            text,
          });
          ctx.ui.notify("Conversation edit staged", "info");
        }
        return true;
      },
      list,
      choice.kind === "reasoning",
    );
  };
  if (choices.length === 1 && choices[0]!.safe) {
    startChoice(choices[0]!);
    return;
  }
  state.flow = "block-choice";
  showFlowComponent(
    selector,
    state,
    [
      "Choose a text block to edit",
      ...choices.map((choice, index) => `${index + 1}: ${choice.label}`),
      "Press 1-9 to choose · Escape back to the tree",
    ],
    (data) => {
      const selectedIndex = Number.parseInt(data, 10) - 1;
      const choice = Number.isInteger(selectedIndex)
        ? choices[selectedIndex]
        : undefined;
      if (!choice) return;
      state.flowComponent?.finish();
      startChoice(choice);
    },
    () => undefined,
    () => undefined,
  );
}

function isSoleReasoningBlock(
  entry: SessionEntryLike,
  blockIndex: number,
): boolean {
  if (
    entry.type !== "message" ||
    !entry.message ||
    typeof entry.message !== "object"
  ) {
    return false;
  }
  const content = (entry.message as Record<string, unknown>).content;
  return Array.isArray(content) && content.length === 1 && blockIndex === 0;
}

function previewChoiceText(text: string): string {
  const normalized = text.replace(/[\t\r\n]+/g, " ").trim();
  if (!normalized) return "(empty)";
  return normalized.length > 60 ? `${normalized.slice(0, 59)}…` : normalized;
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
  const keepEditing = () => {
    ctx.ui.notify("Returned to tree; staged changes were kept", "info");
  };
  const shown = showChoiceMenu(
    selector,
    state,
    list,
    "exit-confirm",
    `Save changes to ${state.operations.length} staged item${state.operations.length === 1 ? "" : "s"}?`,
    [
      { value: "apply", label: "Yes, and return to conversation" },
      {
        value: "keep",
        label: "No. Return to tree and continue making changes",
      },
      {
        value: "discard",
        label: "No. Return to conversation and abandon staged changes",
      },
    ],
    0,
    (value) => {
      if (value === "apply") {
        void previewAndApply(selector, state, list, true);
      } else if (value === "keep") {
        keepEditing();
      } else if (value === "discard") {
        state.operations = [];
        state.snapshot = undefined;
        state.editMode = false;
        list?.onCancel?.();
        ctx.ui.notify("Staged changes discarded", "info");
      }
    },
    keepEditing,
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
  forceMultiline = false,
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
  const input =
    forceMultiline || /[\r\n]/.test(prefill)
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
