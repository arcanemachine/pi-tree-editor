import { planSurgery } from "../surgery/planner.js";
import { applySurgery } from "../surgery/replay.js";
import { activePath } from "../surgery/active-path.js";
import {
  assistantContentBlocks,
  buildLogicalUnits,
  editableTextBlocks,
  reasoningBlockEligibility,
  reasoningBlocks,
  textBlockEligibility,
} from "../surgery/logical-units.js";
import {
  Container,
  getKeybindings,
  Input,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import * as PiTui from "@earendil-works/pi-tui";
import { isObject, type SessionEntryLike } from "../surgery/types.js";
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
  applyFilter?: () => void;
  onSelect?: (entryId: string) => void;
  onCancel?: () => void;
  [key: string | symbol]: unknown;
};

type DisplayTheme = {
  fg(color: string, text: string): string;
};

const TREE_LIST_DISPLAY_PATCHED = Symbol.for(
  "arcanemachine.pi-tree-editor.tree-list-display-patched",
);
const TREE_LIST_VIRTUAL_ROWS_PATCHED = Symbol.for(
  "arcanemachine.pi-tree-editor.tree-list-virtual-rows-patched",
);
const VIRTUAL_ROW = Symbol.for("arcanemachine.pi-tree-editor.virtual-row");

type VirtualRowMeta = {
  anchorUnitId: string;
  position: "before" | "after";
  role: "user" | "assistant" | "context";
  operation: Extract<
    ReturnType<typeof selectorState>["operations"][number],
    { kind: "insert" }
  >;
};

type VirtualNode = {
  entry: SessionEntryLike;
  children: [];
  [VIRTUAL_ROW]?: VirtualRowMeta;
};

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
          "Save with ctrl+s or discard with Escape before leaving edit mode",
          "info",
        );
        return;
      }
      state.editMode = !state.editMode;
      state.reasoningPreviewsVisible = false;
      ctx?.ui.notify(
        state.editMode
          ? "Tree editor mode: ctrl+s save, e edit, d remove, a insert, u unstage"
          : "Tree editor mode off",
        "info",
      );
      return;
    }
    const list = this.getTreeList?.() as TreeListLike | undefined;
    if (list)
      refreshVirtualRows(list, selectorState(this), getDisplayTheme(theme));
    const selected = list?.getSelectedNode?.();
    if (!state.editMode) {
      if (
        selected &&
        isVirtualNode(selected) &&
        getKeybindings().matches(keyData, "tui.select.confirm")
      ) {
        getExtensionContext()?.ui.notify(
          "Staged rows are not navigable until you apply the tree edits",
          "info",
        );
        return;
      }
      originalHandleInput.call(this, keyData);
      return;
    }
    if (state.busy) return;
    if (keyData === "r" || keyData === "R") {
      state.reasoningPreviewsVisible = !state.reasoningPreviewsVisible;
      getExtensionContext()?.ui.notify(
        state.reasoningPreviewsVisible
          ? "Reasoning previews shown"
          : "Reasoning previews hidden",
        "info",
      );
      return;
    }
    if (keyData === "\u001b") {
      if (state.operations.length === 0) {
        state.editMode = false;
        state.reasoningPreviewsVisible = false;
        state.snapshot = undefined;
        list?.onCancel?.();
      } else {
        showExitConfirmation(this, state, list);
      }
      return;
    }
    const virtual = selected && isVirtualNode(selected);
    if (keyData === "u" || keyData === "U") {
      if (!selected) return;
      if (virtual) {
        unstageVirtualRow(state, virtual);
      } else {
        unstageSelected(state, selected.entry.id);
      }
      return;
    }
    if (keyData === "d" || keyData === "D") {
      if (!selected) return;
      if (virtual) {
        getExtensionContext()?.ui.notify(
          "Removal is unavailable for a staged inserted row; use u to unstage it",
          "warning",
        );
        return;
      }
      if (!isActivePathEntry(selected.entry.id)) return;
      if (hasWholeRemoval(state, selected.entry.id)) {
        toggleRemoval(state, selected.entry.id);
      } else if (canOfferPartialRemoval(selected.entry)) {
        beginPartialRemoval(this, state, selected.entry, list);
      } else {
        toggleRemoval(state, selected.entry.id);
      }
      return;
    }
    if (keyData === "a" || keyData === "A") {
      if (!selected) return;
      if (virtual) {
        getExtensionContext()?.ui.notify(
          "Insert actions apply to source tree units, not staged rows",
          "warning",
        );
        return;
      }
      if (!isActivePathEntry(selected.entry.id)) return;
      void beginInsertRole(
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
      if (virtual) {
        editVirtualRow(this, state, virtual, list);
        return;
      }
      if (!isActivePathEntry(selected.entry.id)) return;
      void editEntry(this, state, selected.entry, list);
      return;
    }
    if (isCtrlS(keyData) || (keyData === "s" && hasLegacyInsert(state))) {
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
          ? "Use ctrl+s to save staged tree edits"
          : "No staged tree edits",
        "info",
      );
      return;
    }
    // Keep navigation, filtering, folding, copying, label editing, and plain s native.
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
    const state = selectorState(this);
    const list = this.getTreeList?.() as TreeListLike | undefined;
    if (list) refreshVirtualRows(list, state, theme);
    patchTreeListDisplay(this, state, theme);
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
  if (!list) return;
  patchVirtualRows(list, state, theme);
  if (list[TREE_LIST_DISPLAY_PATCHED]) return;
  const original = list.getEntryDisplayText;
  if (typeof original !== "function") return;
  list.getEntryDisplayText = function (
    this: TreeListLike,
    node: unknown,
    isSelected: boolean,
  ): string {
    if (!getHookStatus().enabled) return original.call(this, node, isSelected);
    const virtual = getVirtualMeta(node);
    if (virtual) {
      return virtualRowDisplay(virtual, theme, isSelected);
    }
    const entry = getDisplayEntry(node);
    if (!entry) return original.call(this, node, isSelected);
    try {
      const display = displayAnnotations(entry, state, theme);
      const displayNode =
        display.edits.length > 0 ||
        display.reasoningEdits.length > 0 ||
        display.removedBlocks.length > 0
          ? cloneDisplayNode(
              node,
              entry,
              display.edits,
              display.reasoningEdits,
              display.removedBlocks,
            )
          : node;
      const rendered = original.call(this, displayNode, isSelected);
      const reasoningPreview =
        state.editMode && state.reasoningPreviewsVisible
          ? display.reasoningPreview
          : "";
      return `${reasoningPreview}${display.marker}${rendered}`;
    } catch {
      return original.call(this, node, isSelected);
    }
  };
  list[TREE_LIST_DISPLAY_PATCHED] = true;
}

type DisplayAnnotations = {
  edits: Array<{ text: string; blockIndex?: number; unsigned?: boolean }>;
  reasoningEdits: Array<{
    thinking: string;
    blockIndex: number;
    unsigned?: boolean;
  }>;
  removedBlocks: Array<{
    blockIndex: number;
    blockType: "text" | "thinking";
  }>;
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

function getVirtualMeta(node: unknown): VirtualRowMeta | undefined {
  if (!node || typeof node !== "object") return undefined;
  const direct = (node as { [VIRTUAL_ROW]?: VirtualRowMeta })[VIRTUAL_ROW];
  if (direct) return direct;
  const nested = (node as { entry?: { [VIRTUAL_ROW]?: VirtualRowMeta } }).entry;
  return nested?.[VIRTUAL_ROW];
}

function virtualRowDisplay(
  meta: VirtualRowMeta,
  theme: DisplayTheme,
  isSelected: boolean,
): string {
  const roleLabel =
    meta.role === "context"
      ? "context"
      : meta.role === "assistant"
        ? "assistant"
        : "user";
  const color =
    meta.role === "assistant"
      ? "success"
      : meta.role === "context"
        ? "customMessageLabel"
        : "accent";
  const preview = meta.operation.text.replace(/[\t\r\n]+/g, " ").trim();
  const bounded = preview.length > 200 ? `${preview.slice(0, 199)}…` : preview;
  return `${theme.fg(color, `[insert ${roleLabel}]`)} ${bounded || "(empty)"}`;
}

type VirtualRowsState = {
  baseFlatNodes: unknown[];
  applyFilter: () => void;
  fingerprint?: string;
};

function patchVirtualRows(
  list: TreeListLike,
  state: ReturnType<typeof selectorState>,
  _theme?: DisplayTheme,
): void {
  let info = list[TREE_LIST_VIRTUAL_ROWS_PATCHED] as
    | VirtualRowsState
    | undefined;
  if (!info) {
    const flatNodes = list.flatNodes;
    const applyFilter = list.applyFilter;
    if (!Array.isArray(flatNodes) || typeof applyFilter !== "function") return;
    info = {
      baseFlatNodes: flatNodes.map((flatNode) => {
        if (!flatNode || typeof flatNode !== "object") return flatNode;
        const source = flatNode as Record<string, unknown>;
        const node = source.node;
        return {
          ...source,
          node:
            node && typeof node === "object"
              ? { ...(node as Record<string, unknown>) }
              : node,
        };
      }),
      applyFilter: applyFilter.bind(list),
    };
    list[TREE_LIST_VIRTUAL_ROWS_PATCHED] = info;
  }
  refreshVirtualRows(list, state, _theme);
}

function refreshVirtualRows(
  list: TreeListLike,
  state: ReturnType<typeof selectorState>,
  theme?: DisplayTheme,
): void {
  if (!list[TREE_LIST_VIRTUAL_ROWS_PATCHED]) {
    patchVirtualRows(list, state, theme);
    return;
  }
  const info = list[TREE_LIST_VIRTUAL_ROWS_PATCHED] as VirtualRowsState;
  const inserts = state.operations.filter(
    (operation): operation is Extract<typeof operation, { kind: "insert" }> =>
      operation.kind === "insert",
  );
  const fingerprint = JSON.stringify(
    inserts.map((operation) => ({
      anchorUnitId: operation.anchorUnitId,
      position: operation.position,
      role: operation.role,
      text: operation.text,
    })),
  );
  if (info.fingerprint === fingerprint) return;
  const base = info.baseFlatNodes;
  const before = new Map<number, unknown[]>();
  const after = new Map<number, unknown[]>();
  const manager = getManager();
  const path = manager
    ? activePath(manager.getEntries(), manager.getLeafId())
    : [];
  const units = buildLogicalUnits(path).units;
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  for (const operation of inserts) {
    const unit = unitById.get(operation.anchorUnitId);
    const boundaryId =
      operation.position === "before"
        ? unit?.entries[0]?.id
        : unit?.entries.at(-1)?.id;
    const anchorId = boundaryId ?? operation.anchorUnitId;
    const index = base.findIndex((flatNode) => {
      if (!flatNode || typeof flatNode !== "object") return false;
      const node = (flatNode as { node?: { entry?: { id?: string } } }).node;
      return node?.entry?.id === anchorId;
    });
    if (index < 0) continue;
    const source = base[index] as {
      node?: { entry?: SessionEntryLike };
    };
    const parentId = source.node?.entry?.parentId ?? null;
    const virtual = createVirtualNode(operation, parentId);
    const target = operation.position === "before" ? before : after;
    const rows = target.get(index) ?? [];
    rows.push({
      node: virtual,
      indent: 0,
      showConnector: false,
      isLast: true,
      gutters: [],
      isVirtualRootChild: false,
    });
    target.set(index, rows);
  }
  const next: unknown[] = [];
  for (let index = 0; index < base.length; index += 1) {
    next.push(...(before.get(index) ?? []), base[index]);
    next.push(...(after.get(index) ?? []));
  }
  list.flatNodes = next;
  info.fingerprint = fingerprint;
  info.applyFilter();
}

function createVirtualNode(
  operation: Extract<
    ReturnType<typeof selectorState>["operations"][number],
    { kind: "insert" }
  >,
  parentId: string | null,
): VirtualNode {
  const id = `pi-tree-editor:insert:${operation.role}:${operation.anchorUnitId}:${operation.position}`;
  const entry: SessionEntryLike =
    operation.role === "context"
      ? {
          type: "custom_message",
          id,
          parentId,
          timestamp: "virtual",
          customType: "context",
          content: operation.text,
          display: true,
        }
      : {
          type: "message",
          id,
          parentId,
          timestamp: "virtual",
          message:
            operation.role === "assistant"
              ? {
                  role: "assistant",
                  content: [{ type: "text", text: operation.text }],
                  api: operation.assistant?.api,
                  provider: operation.assistant?.provider,
                  model: operation.assistant?.model,
                }
              : { role: "user", content: operation.text },
        };
  const node = { entry, children: [] as [] } as VirtualNode;
  node[VIRTUAL_ROW] = {
    anchorUnitId: operation.anchorUnitId,
    position: operation.position,
    role: operation.role,
    operation,
  };
  return node;
}

function isVirtualNode(node: unknown): VirtualRowMeta | undefined {
  return getVirtualMeta(node);
}

function unstageVirtualRow(
  state: ReturnType<typeof selectorState>,
  virtual: VirtualRowMeta,
): void {
  state.operations = state.operations.filter(
    (operation) =>
      !(
        operation.kind === "insert" &&
        operation.anchorUnitId === virtual.anchorUnitId &&
        operation.position === virtual.position
      ),
  );
  if (state.operations.length === 0) state.snapshot = undefined;
  getExtensionContext()?.ui.notify("Staged insertion unstaged", "info");
}

function editVirtualRow(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  virtual: VirtualRowMeta,
  list: TreeListLike | undefined,
): void {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  startInlineEdit(
    selector,
    state,
    virtual.operation.text,
    (text) => {
      if (!text.trim()) {
        ctx.ui.notify("Inserted messages cannot be empty", "warning");
        return false;
      }
      const next = { ...virtual.operation, text };
      state.operations = state.operations.filter(
        (operation) =>
          !(
            operation.kind === "insert" &&
            operation.anchorUnitId === virtual.anchorUnitId &&
            operation.position === virtual.position
          ),
      );
      state.operations.push(next);
      ctx.ui.notify(`Inserted ${virtual.role} row updated`, "info");
      return true;
    },
    list,
  );
}

function hasLegacyInsert(state: ReturnType<typeof selectorState>): boolean {
  return state.operations.some((operation) => operation.kind === "insert-note");
}

function isCtrlS(keyData: string): boolean {
  return matchesKey(keyData, "ctrl+s") || keyData === "\\x13";
}

function cloneDisplayNode(
  node: unknown,
  entry: SessionEntryLike,
  edits: Array<{ text: string; blockIndex?: number; unsigned?: boolean }>,
  reasoningEdits: Array<{
    thinking: string;
    blockIndex: number;
    unsigned?: boolean;
  }>,
  removedBlocks: Array<{
    blockIndex: number;
    blockType: "text" | "thinking";
  }>,
): unknown {
  const clonedEntry = structuredClone(entry) as SessionEntryLike;
  for (const edit of edits) {
    applyDisplayEdit(clonedEntry, edit.text, edit.blockIndex);
    if (edit.unsigned) {
      removeDisplaySignature(clonedEntry, edit.blockIndex ?? 0, "text");
    }
  }
  for (const edit of reasoningEdits) {
    applyDisplayReasoningEdit(clonedEntry, edit.thinking, edit.blockIndex);
    if (edit.unsigned) {
      removeDisplaySignature(clonedEntry, edit.blockIndex, "thinking");
    }
  }
  applyDisplayBlockRemovals(clonedEntry, removedBlocks);
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

function applyDisplayBlockRemovals(
  entry: SessionEntryLike,
  removedBlocks: Array<{
    blockIndex: number;
    blockType: "text" | "thinking";
  }>,
): void {
  if (
    entry.type !== "message" ||
    !entry.message ||
    typeof entry.message !== "object" ||
    !Array.isArray((entry.message as Record<string, unknown>).content)
  ) {
    return;
  }
  const byIndex = new Map(
    removedBlocks.map((block) => [block.blockIndex, block.blockType]),
  );
  const content = (entry.message as Record<string, unknown>)
    .content as unknown[];
  (entry.message as Record<string, unknown>).content = content.filter(
    (block, index) => !isObject(block) || byIndex.get(index) !== block.type,
  );
}

function removeDisplaySignature(
  entry: SessionEntryLike,
  blockIndex: number,
  blockType: "text" | "thinking",
): void {
  if (
    entry.type !== "message" ||
    !entry.message ||
    typeof entry.message !== "object" ||
    !Array.isArray((entry.message as Record<string, unknown>).content)
  ) {
    return;
  }
  const content = (entry.message as Record<string, unknown>)
    .content as unknown[];
  const block = content[blockIndex];
  if (!isObject(block) || block.type !== blockType) return;
  if (blockType === "text") delete block.textSignature;
  else delete block.thinkingSignature;
}

function displayAnnotations(
  entry: SessionEntryLike,
  state: ReturnType<typeof selectorState>,
  theme: DisplayTheme,
): DisplayAnnotations {
  const unit = logicalUnitForEntry(entry.id);
  const operations = state.operations.filter((operation) =>
    operationTargetsEntry(operation, unit, entry.id),
  );
  const edits: DisplayAnnotations["edits"] = operations.flatMap((operation) => {
    if (operation.kind === "edit-text" && operation.entryId === entry.id) {
      return [{ text: operation.text, blockIndex: operation.blockIndex }];
    }
    if (
      operation.kind === "edit-unsigned" &&
      operation.entryId === entry.id &&
      operation.blockType === "text"
    ) {
      return [
        {
          text: operation.text,
          blockIndex: operation.blockIndex,
          unsigned: true,
        },
      ];
    }
    return [];
  });
  const reasoningEdits: DisplayAnnotations["reasoningEdits"] =
    operations.flatMap((operation) => {
      if (
        operation.kind === "edit-reasoning" &&
        operation.entryId === entry.id
      ) {
        return [
          { thinking: operation.thinking, blockIndex: operation.blockIndex },
        ];
      }
      if (
        operation.kind === "edit-unsigned" &&
        operation.entryId === entry.id &&
        operation.blockType === "thinking"
      ) {
        return [
          {
            thinking: operation.text,
            blockIndex: operation.blockIndex,
            unsigned: true,
          },
        ];
      }
      return [];
    });
  const removedBlocks: DisplayAnnotations["removedBlocks"] = operations.flatMap(
    (operation) =>
      operation.kind === "remove-block" && operation.entryId === entry.id
        ? [{ blockIndex: operation.blockIndex, blockType: operation.blockType }]
        : [],
  );
  const isFirstEntry = (unit?.entryIds[0] ?? entry.id) === entry.id;
  const isLastEntry = (unit?.entryIds.at(-1) ?? entry.id) === entry.id;
  const removed = operations.some(
    (operation) => operation.kind === "remove-unit",
  );
  const before = operations.some(
    (operation) =>
      operation.kind === "insert-note" &&
      operation.position === "before" &&
      isFirstEntry,
  );
  const after = operations.some(
    (operation) =>
      operation.kind === "insert-note" &&
      operation.position === "after" &&
      isLastEntry,
  );
  const sourceReasoning = reasoningBlocks(entry);
  const removedReasoning = removedBlocks.find(
    (block) => block.blockType === "thinking",
  );
  const stagedReasoning =
    reasoningEdits.find(
      (edit) => edit.blockIndex === sourceReasoning[0]?.blockIndex,
    ) ??
    reasoningEdits[0] ??
    (removedReasoning
      ? { thinking: "", blockIndex: removedReasoning.blockIndex }
      : undefined);
  const previewBlock = stagedReasoning
    ? {
        text: stagedReasoning.thinking,
        safe: true,
        removed: stagedReasoning.thinking.trim().length === 0,
      }
    : sourceReasoning[0]
      ? {
          text: sourceReasoning[0].text,
          safe: sourceReasoning[0].safe,
          reason: sourceReasoning[0].reason,
          removed: false,
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
  const unsignedText = edits.some((edit) => edit.unsigned);
  const unsignedReasoning = reasoningEdits.some((edit) => edit.unsigned);
  const markers = [
    removed ? theme.fg("error", "[remove] ") : "",
    removedBlocks.some((block) => block.blockType === "thinking")
      ? theme.fg("error", "[remove reasoning] ")
      : "",
    removedBlocks.some((block) => block.blockType === "text")
      ? theme.fg("error", "[remove answer] ")
      : "",
    unsignedText
      ? theme.fg("warning", "[edit unsigned] ")
      : edits.length > 0
        ? theme.fg("warning", "[edit] ")
        : "",
    unsignedReasoning
      ? theme.fg("warning", "[edit reasoning unsigned] ")
      : reasoningEdits.length > 0
        ? theme.fg("warning", "[edit reasoning] ")
        : "",
    before ? theme.fg("accent", "[insert before] ") : "",
    after ? theme.fg("accent", "[insert after] ") : "",
  ];
  return {
    edits,
    reasoningEdits,
    removedBlocks,
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
    : state.flow === "role-choice"
      ? "Insert role: User · Assistant · Context note · Escape cancel"
      : state.flow === "save-review"
        ? "Tree editor save: ctrl+s · Yes apply and reopen tree · Cancel keep staged"
        : state.flow === "exit-confirm"
          ? "Exit menu: Yes save · No keep editing · No abandon"
          : state.editMode
            ? "Tree editor ON: ctrl+s save · e edit · d remove · a/Shift+A insert · u unstage · r reasoning"
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

function isBlockEdit(operation: StagedOperation): operation is Extract<
  StagedOperation,
  {
    kind: "edit-text" | "edit-reasoning" | "edit-unsigned" | "remove-block";
  }
> {
  return (
    operation.kind === "edit-text" ||
    operation.kind === "edit-reasoning" ||
    operation.kind === "edit-unsigned" ||
    operation.kind === "remove-block"
  );
}

function blockOperationKey(operation: StagedOperation): string | undefined {
  if (operation.kind === "edit-text") {
    return `${operation.entryId}:${operation.blockIndex ?? 0}:text`;
  }
  if (operation.kind === "edit-reasoning") {
    return `${operation.entryId}:${operation.blockIndex}:thinking`;
  }
  if (operation.kind === "edit-unsigned" || operation.kind === "remove-block") {
    return `${operation.entryId}:${operation.blockIndex}:${operation.blockType}`;
  }
  return undefined;
}

function operationTargetsUnit(
  operation: StagedOperation,
  unit: LogicalUnitLike | undefined,
  entryId: string,
): boolean {
  const entryIds = unit?.entryIds ?? [entryId];
  if (isBlockEdit(operation)) return entryIds.includes(operation.entryId);
  const targetId =
    operation.kind === "remove-unit"
      ? operation.unitId
      : operation.anchorUnitId;
  return targetId === (unit?.id ?? entryId) || entryIds.includes(targetId);
}

function operationTargetsEntry(
  operation: StagedOperation,
  unit: LogicalUnitLike | undefined,
  entryId: string,
): boolean {
  return isBlockEdit(operation)
    ? operation.entryId === entryId
    : operationTargetsUnit(operation, unit, entryId);
}

function replaceOperationForUnit(
  state: ReturnType<typeof selectorState>,
  unit: LogicalUnitLike | undefined,
  entryId: string,
  operation: StagedOperation,
): void {
  const targetKey = blockOperationKey(operation);
  state.operations = state.operations.filter((candidate) => {
    if (targetKey !== undefined) {
      if (
        candidate.kind === "remove-unit" &&
        operationTargetsUnit(candidate, unit, entryId)
      ) {
        return false;
      }
      if (
        isBlockEdit(candidate) &&
        blockOperationKey(candidate) === targetKey
      ) {
        return false;
      }
      if (
        (candidate.kind === "insert" || candidate.kind === "insert-note") &&
        operationTargetsUnit(candidate, unit, entryId)
      ) {
        return false;
      }
      return true;
    }
    return !operationTargetsUnit(candidate, unit, entryId);
  });
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

function hasWholeRemoval(
  state: ReturnType<typeof selectorState>,
  entryId: string,
): boolean {
  const unit = logicalUnitForEntry(entryId);
  return state.operations.some(
    (operation) =>
      operation.kind === "remove-unit" &&
      operationTargetsUnit(operation, unit, entryId),
  );
}

function canOfferPartialRemoval(entry: SessionEntryLike): boolean {
  return (
    entry.type === "message" &&
    isObject(entry.message) &&
    (entry.message as Record<string, unknown>).role === "assistant" &&
    assistantContentBlocks(entry).length > 1
  );
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

async function beginInsertRole(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  anchorEntryId: string,
  position: "before" | "after",
  list: TreeListLike | undefined,
  selectedRole?: "user" | "assistant" | "context",
): Promise<void> {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  if (
    !list ||
    !Array.isArray(list.flatNodes) ||
    typeof list.applyFilter !== "function"
  ) {
    ctx.ui.notify(
      "Inserted rows are unavailable in this Pi build; native /tree remains unchanged",
      "warning",
    );
    return;
  }
  const items: ChoiceItem[] = [
    { value: "user", label: "User" },
    { value: "assistant", label: "Assistant" },
    { value: "context", label: "Context note" },
  ];
  const shown = showChoiceMenu(
    selector,
    state,
    list,
    "role-choice",
    "Choose inserted row role",
    items,
    selectedRole ? items.findIndex((item) => item.value === selectedRole) : 0,
    (value) => {
      const role = value as "user" | "assistant" | "context";
      const assistant =
        role === "assistant" ? activeModelIdentity() : undefined;
      if (role === "assistant" && !assistant) {
        ctx.ui.notify(
          "Assistant insertion unavailable: the active model api, provider, and model identity could not be determined",
          "warning",
        );
        return;
      }
      startInsertInput(
        selector,
        state,
        anchorEntryId,
        position,
        role,
        assistant,
        list,
        false,
        "",
        () => {
          void beginInsertRole(
            selector,
            state,
            anchorEntryId,
            position,
            list,
            role,
          );
        },
      );
    },
    () => undefined,
  );
  if (!shown || !state.flowComponent) return;
  // Keep a compatibility path for the original context-note text-first flow.
  // A printable character is not a selector action, so treat it as the first
  // character of a context note instead of staging anything immediately.
  const menuFlow = state.flowComponent;
  state.flowComponent = {
    ...menuFlow,
    handleInput: (data) => {
      if (["\u001b", "\r", "\n", "\u001b[A", "\u001b[B"].includes(data)) {
        menuFlow.handleInput(data);
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        menuFlow.cancel();
        startInsertInput(
          selector,
          state,
          anchorEntryId,
          position,
          "context",
          undefined,
          list,
          true,
          data,
          () => {
            void beginInsertRole(
              selector,
              state,
              anchorEntryId,
              position,
              list,
              "context",
            );
          },
        );
        return;
      }
      menuFlow.handleInput(data);
    },
  };
}

function activeModelIdentity():
  | { api: string; provider: string; model: string }
  | undefined {
  const mode = getActiveMode();
  const session = mode?.session as Record<string, unknown> | undefined;
  const contextModel = (
    getExtensionContext() as Record<string, unknown> | undefined
  )?.model;
  const model = session?.model ?? contextModel;
  if (model && typeof model === "object") {
    const candidate = model as Record<string, unknown>;
    if (
      typeof candidate.api === "string" &&
      typeof candidate.provider === "string" &&
      typeof candidate.id === "string" &&
      candidate.api &&
      candidate.provider &&
      candidate.id
    ) {
      return {
        api: candidate.api,
        provider: candidate.provider,
        model: candidate.id,
      };
    }
  }
  const manager = getManager();
  if (!manager) return undefined;
  const path = activePath(manager.getEntries(), manager.getLeafId());
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    const message = entry?.message;
    if (
      entry?.type === "message" &&
      message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      const candidate = message as Record<string, unknown>;
      if (
        typeof candidate.api === "string" &&
        typeof candidate.provider === "string" &&
        typeof candidate.model === "string" &&
        candidate.api &&
        candidate.provider &&
        candidate.model
      ) {
        return {
          api: candidate.api,
          provider: candidate.provider,
          model: candidate.model,
        };
      }
    }
  }
  return undefined;
}

function startInsertInput(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  anchorEntryId: string,
  position: "before" | "after",
  role: "user" | "assistant" | "context",
  assistant: { api: string; provider: string; model: string } | undefined,
  list: TreeListLike | undefined,
  legacy = false,
  initialText = "",
  onBack?: () => void,
): void {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  startInlineEdit(
    selector,
    state,
    initialText,
    (text) => {
      if (!text.trim()) {
        ctx.ui.notify("Inserted messages cannot be empty", "warning");
        return false;
      }
      snapshotIfNeeded(state);
      const unit = logicalUnitForEntry(anchorEntryId);
      const anchorUnitId = unit?.id ?? anchorEntryId;
      replaceOperationForUnit(
        state,
        unit,
        anchorEntryId,
        legacy
          ? {
              kind: "insert-note",
              anchorUnitId,
              position,
              text,
            }
          : {
              kind: "insert",
              anchorUnitId,
              position,
              role,
              text,
              ...(assistant ? { assistant } : {}),
            },
      );
      ctx.ui.notify(
        legacy ? "Context note staged" : `Inserted ${role} row staged`,
        "info",
      );
      return true;
    },
    list,
    !legacy && canUseMultilineEditor(),
    onBack,
  );
}

function canUseMultilineEditor(): boolean {
  const ui = getActiveMode()?.ui;
  return Boolean(
    ui &&
    typeof ui === "object" &&
    (ui as Record<string, unknown>).terminal &&
    typeof (ui as { terminal?: { rows?: unknown } }).terminal?.rows ===
      "number",
  );
}

type EditChoice = {
  kind: "text" | "reasoning";
  blockType: "text" | "thinking";
  blockIndex: number;
  text: string;
  safe: boolean;
  signedTarget?: boolean;
  reason?: string;
  label: string;
};

type RemoveChoice = {
  blockType: "text" | "thinking";
  blockIndex: number;
  text: string;
  safe: boolean;
  signedTarget?: boolean;
  reason?: string;
  label: string;
};

function existingBlockOperation(
  state: ReturnType<typeof selectorState>,
  entryId: string,
  choice: Pick<EditChoice, "kind" | "blockType" | "blockIndex">,
): StagedOperation | undefined {
  return state.operations.find((operation) => {
    if (!isBlockEdit(operation) || operation.entryId !== entryId) return false;
    return (
      blockOperationKey(operation) ===
      `${entryId}:${choice.blockIndex}:${choice.blockType}`
    );
  });
}

function beginPartialRemoval(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  list: TreeListLike | undefined,
): void {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  const blocks = assistantContentBlocks(entry);
  const choices: RemoveChoice[] = [
    ...blocks
      .filter((block) => block.blockType === "thinking")
      .map((block) => {
        const eligibility = reasoningBlockEligibility(entry, block.blockIndex);
        return {
          blockType: block.blockType,
          blockIndex: block.blockIndex,
          text: block.text,
          safe: eligibility.eligible,
          signedTarget: eligibility.signedTarget,
          reason: eligibility.reason,
          label: `Reasoning — ${previewChoiceText(block.text)}${
            eligibility.signedTarget
              ? " (provider-signed)"
              : eligibility.eligible
                ? ""
                : ` (read-only: ${eligibility.reason ?? "unsupported"})`
          }`,
        };
      }),
    ...blocks
      .filter((block) => block.blockType === "text")
      .map((block) => {
        const eligibility = textBlockEligibility(entry, block.blockIndex);
        return {
          blockType: block.blockType,
          blockIndex: block.blockIndex,
          text: block.text,
          safe: eligibility.eligible,
          signedTarget: eligibility.signedTarget,
          reason: eligibility.reason,
          label: `Answer text — ${previewChoiceText(block.text)}${
            eligibility.signedTarget
              ? " (provider-signed)"
              : eligibility.eligible
                ? ""
                : ` (read-only: ${eligibility.reason ?? "unsupported"})`
          }`,
        };
      }),
  ];
  if (choices.length <= 1) {
    toggleRemoval(state, entry.id);
    return;
  }
  state.flow = "block-choice";
  showFlowComponent(
    selector,
    state,
    [
      "Delete:",
      ...choices.map((choice, index) => `${index + 1}: ${choice.label}`),
      `${choices.length + 1}: Entire assistant message`,
      "Escape back to the tree",
    ],
    (data) => {
      const selectedIndex = Number.parseInt(data, 10) - 1;
      if (selectedIndex === choices.length) {
        state.flowComponent?.finish();
        toggleRemoval(state, entry.id);
        return;
      }
      const choice = Number.isInteger(selectedIndex)
        ? choices[selectedIndex]
        : undefined;
      if (!choice) return;
      state.flowComponent?.finish();
      if (choice.signedTarget) {
        showSignedRemoval(selector, state, entry, choice, list);
        return;
      }
      if (!choice.safe) {
        ctx.ui.notify(
          `This entry is read-only (${choice.reason ?? "unsupported"})`,
          "warning",
        );
        return;
      }
      stageBlockRemoval(state, entry, choice, false, false);
    },
    () => undefined,
    () => undefined,
  );
}

function stageBlockRemoval(
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  choice: RemoveChoice,
  signatureDetached: boolean,
  unsafe: boolean,
): void {
  const ctx = getExtensionContext();
  const unit = logicalUnitForEntry(entry.id);
  const existing = state.operations.find(
    (operation) =>
      operation.kind === "remove-block" &&
      operation.entryId === entry.id &&
      operation.blockIndex === choice.blockIndex &&
      operation.blockType === choice.blockType,
  );
  if (existing) {
    state.operations = state.operations.filter(
      (operation) => operation !== existing,
    );
    if (state.operations.length === 0) state.snapshot = undefined;
    ctx?.ui.notify("Partial block removal unstaged", "info");
    return;
  }
  if (wouldRemoveFinalAssistantBlock(state, entry, choice)) {
    ctx?.ui.notify(
      "Cannot remove the final retained content block; choose Entire assistant message instead",
      "warning",
    );
    return;
  }
  snapshotIfNeeded(state);
  replaceOperationForUnit(state, unit, entry.id, {
    kind: "remove-block",
    entryId: entry.id,
    blockIndex: choice.blockIndex,
    blockType: choice.blockType,
    signatureDetached,
    unsafe,
  });
  ctx?.ui.notify(
    signatureDetached
      ? "Provider signature removed; future provider continuity may fail. Partial block removal staged"
      : `Remove ${choice.blockType === "thinking" ? "reasoning" : "answer"} staged`,
    signatureDetached ? "warning" : "info",
  );
}

function wouldRemoveFinalAssistantBlock(
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  choice: RemoveChoice,
): boolean {
  const blocks = assistantContentBlocks(entry);
  if (blocks.length === 0) return true;
  const targetKey = `${entry.id}:${choice.blockIndex}:${choice.blockType}`;
  const alreadyRemoved = state.operations.some(
    (operation) =>
      operation.kind === "remove-block" &&
      blockOperationKey(operation) === targetKey,
  );
  if (alreadyRemoved) return false;
  const remaining = blocks.filter((block) => {
    if (block.blockIndex === choice.blockIndex) return false;
    return !state.operations.some((operation) => {
      if (!isBlockEdit(operation) || operation.entryId !== entry.id) {
        return false;
      }
      if (operation.kind === "edit-text") return false;
      const blockType =
        operation.kind === "edit-reasoning" ? "thinking" : operation.blockType;
      if (
        operation.blockIndex !== block.blockIndex ||
        blockType !== block.blockType
      ) {
        return false;
      }
      return (
        operation.kind === "remove-block" ||
        (operation.kind === "edit-reasoning" &&
          operation.thinking.trim().length === 0) ||
        (operation.kind === "edit-unsigned" &&
          operation.text.trim().length === 0 &&
          operation.blockType === "thinking")
      );
    });
  });
  return remaining.length === 0;
}

function showSignedRemoval(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  choice: RemoveChoice,
  list: TreeListLike | undefined,
): void {
  const shown = showChoiceMenu(
    selector,
    state,
    list,
    "signed-removal",
    "This block is provider-signed and cannot be removed safely. Remove it anyways?",
    [
      { value: "no", label: "No. Return to previous menu" },
      {
        value: "yes",
        label: "Yes. Create an unsigned copy without this block",
      },
    ],
    0,
    (value) => {
      if (value === "yes") {
        stageBlockRemoval(state, entry, choice, true, true);
      } else {
        beginPartialRemoval(selector, state, entry, list);
      }
    },
    () => undefined,
    () => beginPartialRemoval(selector, state, entry, list),
  );
  if (!shown) return;
}

async function editEntry(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  list: TreeListLike | undefined,
  forceChooser = false,
): Promise<void> {
  const ctx = getExtensionContext();
  if (!ctx?.hasUI) return;
  const choices: EditChoice[] = [
    ...reasoningBlocks(entry).map((block) => ({
      kind: "reasoning" as const,
      blockType: "thinking" as const,
      blockIndex: block.blockIndex,
      text: block.text,
      safe: block.safe,
      signedTarget: block.signedTarget,
      reason: block.reason,
      label: `Reasoning — ${previewChoiceText(block.text)}${
        block.signedTarget
          ? " (provider-signed)"
          : block.safe
            ? ""
            : ` (read-only: ${block.reason ?? "unsupported"})`
      }`,
    })),
    ...editableTextBlocks(entry).map((block) => {
      const eligibility = textBlockEligibility(entry, block.blockIndex);
      return {
        kind: "text" as const,
        blockType: "text" as const,
        blockIndex: block.blockIndex,
        text: block.text,
        safe: eligibility.eligible,
        signedTarget: eligibility.signedTarget,
        reason: eligibility.reason,
        label: `Answer text — ${previewChoiceText(block.text)}${
          eligibility.signedTarget
            ? " (provider-signed)"
            : eligibility.reason
              ? ` (read-only: ${eligibility.reason})`
              : ""
        }`,
      };
    }),
  ];
  if (choices.length === 0) {
    ctx.ui.notify(
      "This tree entry has no editable text or reasoning block",
      "warning",
    );
    return;
  }
  const restoreChooser = () => {
    void editEntry(selector, state, entry, list, true);
  };
  const startChoice = (choice: EditChoice, onBack?: () => void) => {
    const unit = logicalUnitForEntry(entry.id);
    if (choice.signedTarget) {
      showSignedOverride(selector, state, entry, unit, choice, list, onBack);
      return;
    }
    if (!choice.safe) {
      ctx.ui.notify(
        `This entry is read-only (${choice.reason ?? "unsupported"})`,
        "warning",
      );
      return;
    }
    const existing = existingBlockOperation(state, entry.id, choice);
    const prefill =
      existing?.kind === "edit-text"
        ? existing.text
        : existing?.kind === "edit-reasoning"
          ? existing.thinking
          : existing?.kind === "edit-unsigned"
            ? existing.text
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
      onBack,
    );
  };
  if (!forceChooser && choices.length === 1 && choices[0]!.safe) {
    startChoice(choices[0]!);
    return;
  }
  if (!forceChooser && choices.length === 1 && choices[0]!.signedTarget) {
    startChoice(choices[0]!, restoreChooser);
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
      startChoice(choice, restoreChooser);
    },
    () => undefined,
    () => undefined,
  );
}

function showSignedOverride(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  entry: SessionEntryLike,
  unit: LogicalUnitLike | undefined,
  choice: EditChoice,
  list: TreeListLike | undefined,
  onBack?: () => void,
): void {
  const shown = showChoiceMenu(
    selector,
    state,
    list,
    "signed-override",
    "This block is provider-signed and cannot be edited safely. Edit it anyways?",
    [
      { value: "no", label: "No. Return to previous menu" },
      { value: "yes", label: "Yes. Create an unsigned editable copy" },
    ],
    0,
    (value) => {
      if (value !== "yes") {
        onBack?.();
        return;
      }
      const ctx = getExtensionContext();
      if (!ctx?.hasUI) return;
      const blockType = choice.blockType;
      const existing = existingBlockOperation(state, entry.id, choice);
      const prefill =
        existing?.kind === "edit-unsigned" ? existing.text : choice.text;
      startInlineEdit(
        selector,
        state,
        prefill,
        (text) => {
          if (
            blockType === "thinking" &&
            text.trim().length === 0 &&
            isSoleReasoningBlock(entry, choice.blockIndex)
          ) {
            ctx.ui.notify(
              "Cannot remove the only content block from an assistant entry",
              "warning",
            );
            return false;
          }
          snapshotIfNeeded(state);
          replaceOperationForUnit(state, unit, entry.id, {
            kind: "edit-unsigned",
            entryId: entry.id,
            blockIndex: choice.blockIndex,
            blockType,
            text,
          });
          ctx.ui.notify(
            `Provider signature removed; future provider continuity may fail. Unsigned ${choice.kind} copy staged`,
            "warning",
          );
          return true;
        },
        list,
        blockType === "thinking",
        onBack,
      );
    },
    () => undefined,
    onBack,
  );
  if (!shown) return;
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
    handleInput: (data) => {
      if (matchesKey(data, "escape") || data === "\u001b") {
        state.flowComponent?.cancel();
        return;
      }
      onInput(data);
    },
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

type ChoiceFlow =
  | "save-review"
  | "exit-confirm"
  | "role-choice"
  | "signed-override"
  | "signed-removal";

type SaveDestination = "tree" | "conversation";

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
  onBack?: () => void,
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
    (onBack ?? onCancel)();
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
      { value: "apply", label: "Yes. Return to conversation" },
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
        void previewAndApply(selector, state, list, "conversation");
      } else if (value === "keep") {
        keepEditing();
      } else if (value === "discard") {
        state.operations = [];
        state.snapshot = undefined;
        state.editMode = false;
        state.reasoningPreviewsVisible = false;
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
      { value: "yes", label: "Yes. Apply and return to tree" },
      { value: "cancel", label: "Cancel" },
    ],
    0,
    (value) => {
      if (value === "yes") {
        void previewAndApply(selector, state, list, "tree");
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
  onBack?: () => void,
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
  const cancel = () => {
    finish();
    onBack?.();
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
  if (input instanceof Input) input.onEscape = cancel;
  state.inlineInput = { input, finish, cancel, submit: submitInline };
  treeContainer.clear();
  labelInputContainer.clear();
  labelInputContainer.addChild(input);
}

async function previewAndApply(
  selector: SelectorLike,
  state: ReturnType<typeof selectorState>,
  list: TreeListLike | undefined,
  destination: SaveDestination,
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
    state.reasoningPreviewsVisible = false;
    const interactive = mode as Record<string, any> | undefined;
    const uiWarnings: string[] = [];
    try {
      list?.onCancel?.();
    } catch (error) {
      uiWarnings.push(
        `the old tree view could not be closed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (destination === "tree") {
      const showTreeSelector = interactive?.showTreeSelector;
      if (typeof showTreeSelector === "function") {
        try {
          showTreeSelector.call(interactive);
        } catch (error) {
          uiWarnings.push(
            `/tree could not be reopened (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      } else {
        uiWarnings.push("/tree could not be reopened; reopen it manually");
      }
      try {
        interactive?.showStatus?.("Applied copy-on-write tree edits");
        interactive?.ui?.requestRender?.();
      } catch (error) {
        uiWarnings.push(
          `the refreshed tree could not be rendered (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } else {
      try {
        interactive?.chatContainer?.clear?.();
        interactive?.renderInitialMessages?.();
        interactive?.showStatus?.("Applied copy-on-write tree edits");
        interactive?.ui?.requestRender?.();
      } catch (error) {
        uiWarnings.push(
          `the conversation view could not be refreshed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (uiWarnings.length > 0) {
      ctx.ui.notify(
        `Tree edits applied (${result.auditEntryId}), but ${uiWarnings.join("; ")}`,
        "warning",
      );
    } else {
      ctx.ui.notify(`Tree edits applied (${result.auditEntryId})`, "info");
    }
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
