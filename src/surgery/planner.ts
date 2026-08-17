import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { activePath, indexEntries, pathEntryMap } from "./active-path.js";
import {
  assertEditable,
  buildLogicalUnits,
  assistantContentBlocks,
  editableTextBlocks,
  reasoningBlockEligibility,
  reasoningBlocks,
  textBlockEligibility,
} from "./logical-units.js";
import {
  SurgeryError,
  clone,
  isObject,
  type LogicalUnit,
  type ReplayItem,
  type SessionEntryLike,
  type SurgeryOperation,
  type SurgeryPlan,
} from "./types.js";

export type PlanInput = {
  entries: SessionEntryLike[];
  leafId: string | null;
  operations: SurgeryOperation[];
  sessionId?: string;
};

export function planSurgery(input: PlanInput): SurgeryPlan {
  const sourceEntries = clone(input.entries);
  const sourcePath = activePath(sourceEntries, input.leafId);
  if (!input.leafId || sourcePath.length === 0) {
    throw new SurgeryError(
      "EMPTY_SESSION",
      "There is no active conversation path to edit",
    );
  }
  if (input.operations.length === 0) {
    throw new SurgeryError(
      "NO_OPERATIONS",
      "No conversation edits were staged",
    );
  }

  const { units, issues } = buildLogicalUnits(sourcePath);
  if (issues.length > 0) {
    throw new SurgeryError(
      "MALFORMED_TOOL_EXCHANGE",
      issues.join("; "),
      issues,
    );
  }
  const unitById = new Map<string, LogicalUnit>();
  const entryToUnit = new Map<string, LogicalUnit>();
  for (const unit of units) {
    unitById.set(unit.id, unit);
    for (const entryId of unit.entryIds) entryToUnit.set(entryId, unit);
  }
  const pathIndices = pathEntryMap(sourcePath);
  const sourceById = indexEntries(sourceEntries);
  const normalized = input.operations.map((operation) => clone(operation));
  const removedUnits = new Set<string>();
  const edited = new Map<string, { blockIndex: number; text: string }>();
  const reasoningEdited = new Map<
    string,
    { blockIndex: number; thinking: string }
  >();
  const unsignedEdited = new Map<
    string,
    { blockIndex: number; blockType: "text" | "thinking"; text: string }
  >();
  const removedBlocks = new Map<
    string,
    {
      blockIndex: number;
      blockType: "text" | "thinking";
      signatureDetached: boolean;
      unsafe: boolean;
      originalLength: number;
    }
  >();
  const claimedBlockTargets = new Set<string>();
  const inserts: Array<
    | Extract<SurgeryOperation, { kind: "insert" }>
    | Extract<SurgeryOperation, { kind: "insert-note" }>
  > = [];
  const affectedIndices: number[] = [];

  for (const operation of normalized) {
    if (operation.kind === "edit-text") {
      const entry = sourceById.get(operation.entryId);
      const unit = entryToUnit.get(operation.entryId);
      if (!entry || !unit || !pathIndices.has(operation.entryId)) {
        throw new SurgeryError(
          "OFF_PATH_TARGET",
          `Entry ${operation.entryId} is not on the active path`,
        );
      }
      if (removedUnits.has(unit.id)) {
        throw new SurgeryError(
          "CONFLICTING_OPERATION",
          `Entry ${entry.id} is already marked for removal`,
        );
      }
      assertEditable(entry);
      const blocks = editableTextBlocks(entry);
      const blockIndex =
        operation.blockIndex ??
        (blocks.length === 1 ? blocks[0].blockIndex : 0);
      const block = blocks.find(
        (candidate) => candidate.blockIndex === blockIndex,
      );
      if (!block) {
        throw new SurgeryError(
          "INVALID_TEXT_BLOCK",
          `Entry ${entry.id} has no editable text block at index ${blockIndex}`,
        );
      }
      const eligibility = textBlockEligibility(entry, blockIndex);
      if (!eligibility.eligible) {
        throw new SurgeryError(
          eligibility.reason === "provider-signed"
            ? "SIGNED_BLOCK_REQUIRES_UNSIGNED_COPY"
            : "TEXT_BLOCK_PROTECTED",
          `Text block ${entry.id}:${blockIndex} is read-only (${eligibility.reason ?? "unsupported"})`,
        );
      }
      if (typeof operation.text !== "string") {
        throw new SurgeryError("INVALID_TEXT", "Edited text must be a string");
      }
      operation.blockIndex = blockIndex;
      claimBlockTarget(
        claimedBlockTargets,
        `${entry.id}:${blockIndex}:text`,
        operation,
      );
      edited.set(`${entry.id}:${blockIndex}`, {
        blockIndex,
        text: operation.text,
      });
      affectedIndices.push(pathIndices.get(entry.id)!);
      continue;
    }

    if (operation.kind === "edit-reasoning") {
      const entry = sourceById.get(operation.entryId);
      const unit = entryToUnit.get(operation.entryId);
      if (!entry || !unit || !pathIndices.has(operation.entryId)) {
        throw new SurgeryError(
          "OFF_PATH_TARGET",
          `Entry ${operation.entryId} is not on the active path`,
        );
      }
      if (removedUnits.has(unit.id)) {
        throw new SurgeryError(
          "CONFLICTING_OPERATION",
          `Entry ${entry.id} is already marked for removal`,
        );
      }
      const eligibility = reasoningBlockEligibility(
        entry,
        operation.blockIndex,
      );
      if (!eligibility.eligible) {
        throw new SurgeryError(
          "REASONING_PROTECTED",
          `Assistant reasoning is read-only (${eligibility.reason ?? "unsupported"})`,
        );
      }
      const block = reasoningBlocks(entry).find(
        (candidate) => candidate.blockIndex === operation.blockIndex,
      );
      if (!block) {
        throw new SurgeryError(
          "INVALID_REASONING_BLOCK",
          `Entry ${entry.id} has no editable reasoning block at index ${operation.blockIndex}`,
        );
      }
      if (typeof operation.thinking !== "string") {
        throw new SurgeryError(
          "INVALID_REASONING",
          "Edited reasoning must be a string",
        );
      }
      if (
        operation.thinking.trim().length === 0 &&
        isSoleReasoningBlock(entry, operation.blockIndex)
      ) {
        throw new SurgeryError(
          "INVALID_REASONING",
          "Cannot remove the only content block from an assistant entry",
        );
      }
      claimBlockTarget(
        claimedBlockTargets,
        `${entry.id}:${operation.blockIndex}:thinking`,
        operation,
      );
      reasoningEdited.set(`${entry.id}:${operation.blockIndex}`, {
        blockIndex: operation.blockIndex,
        thinking: operation.thinking,
      });
      affectedIndices.push(pathIndices.get(entry.id)!);
      continue;
    }

    if (operation.kind === "edit-unsigned") {
      const entry = sourceById.get(operation.entryId);
      const unit = entryToUnit.get(operation.entryId);
      if (!entry || !unit || !pathIndices.has(operation.entryId)) {
        throw new SurgeryError(
          "OFF_PATH_TARGET",
          `Entry ${operation.entryId} is not on the active path`,
        );
      }
      if (removedUnits.has(unit.id)) {
        throw new SurgeryError(
          "CONFLICTING_OPERATION",
          `Entry ${entry.id} is already marked for removal`,
        );
      }
      const eligibility =
        operation.blockType === "text"
          ? textBlockEligibility(entry, operation.blockIndex)
          : reasoningBlockEligibility(entry, operation.blockIndex);
      if (!eligibility.signedTarget) {
        throw new SurgeryError(
          "UNSIGNED_DETACH_TARGET",
          `Block ${entry.id}:${operation.blockIndex} is not an eligible provider-signed ${operation.blockType} block`,
        );
      }
      if (typeof operation.text !== "string") {
        throw new SurgeryError(
          "INVALID_TEXT",
          "Unsigned copied content must be a string",
        );
      }
      if (
        operation.blockType === "thinking" &&
        operation.text.trim().length === 0 &&
        isSoleReasoningBlock(entry, operation.blockIndex)
      ) {
        throw new SurgeryError(
          "INVALID_REASONING",
          "Cannot remove the only content block from an assistant entry",
        );
      }
      claimBlockTarget(
        claimedBlockTargets,
        `${entry.id}:${operation.blockIndex}:${operation.blockType}`,
        operation,
      );
      unsignedEdited.set(`${entry.id}:${operation.blockIndex}`, {
        blockIndex: operation.blockIndex,
        blockType: operation.blockType,
        text: operation.text,
      });
      affectedIndices.push(pathIndices.get(entry.id)!);
      continue;
    }

    if (operation.kind === "remove-block") {
      const entry = sourceById.get(operation.entryId);
      const unit = entryToUnit.get(operation.entryId);
      if (!entry || !unit || !pathIndices.has(operation.entryId)) {
        throw new SurgeryError(
          "OFF_PATH_TARGET",
          `Entry ${operation.entryId} is not on the active path`,
        );
      }
      if (removedUnits.has(unit.id)) {
        throw new SurgeryError(
          "CONFLICTING_OPERATION",
          `Entry ${entry.id} is already marked for removal`,
        );
      }
      const block = assistantContentBlocks(entry).find(
        (candidate) => candidate.blockIndex === operation.blockIndex,
      );
      if (!block || block.blockType !== operation.blockType) {
        throw new SurgeryError(
          "INVALID_BLOCK_REMOVAL",
          `Entry ${entry.id} has no removable ${operation.blockType} block at index ${operation.blockIndex}`,
        );
      }
      const eligibility =
        operation.blockType === "text"
          ? textBlockEligibility(entry, operation.blockIndex)
          : reasoningBlockEligibility(entry, operation.blockIndex);
      if (
        typeof operation.signatureDetached !== "boolean" ||
        typeof operation.unsafe !== "boolean" ||
        operation.signatureDetached !== operation.unsafe
      ) {
        throw new SurgeryError(
          "INVALID_BLOCK_REMOVAL",
          "Block removal signature-detach and unsafe facts must agree",
        );
      }
      if (eligibility.signedTarget) {
        if (!operation.unsafe || !operation.signatureDetached) {
          throw new SurgeryError(
            "SIGNED_BLOCK_REQUIRES_UNSIGNED_COPY",
            `Block ${entry.id}:${operation.blockIndex} requires explicit unsigned removal`,
          );
        }
      } else {
        if (operation.unsafe || operation.signatureDetached) {
          throw new SurgeryError(
            "INVALID_BLOCK_REMOVAL",
            `Block ${entry.id}:${operation.blockIndex} is not provider-signed`,
          );
        }
        if (!eligibility.eligible) {
          throw new SurgeryError(
            "BLOCK_REMOVAL_PROTECTED",
            `Assistant ${operation.blockType} block is read-only (${eligibility.reason ?? "unsupported"})`,
          );
        }
      }
      claimBlockTarget(
        claimedBlockTargets,
        `${entry.id}:${operation.blockIndex}:${operation.blockType}`,
        operation,
      );
      removedBlocks.set(`${entry.id}:${operation.blockIndex}`, {
        blockIndex: operation.blockIndex,
        blockType: operation.blockType,
        signatureDetached: operation.signatureDetached,
        unsafe: operation.unsafe,
        originalLength: block.text.length,
      });
      affectedIndices.push(pathIndices.get(entry.id)!);
      continue;
    }

    if (operation.kind === "remove-unit") {
      const unit =
        unitById.get(operation.unitId) ?? entryToUnit.get(operation.unitId);
      if (!unit) {
        throw new SurgeryError(
          "OFF_PATH_TARGET",
          `Logical unit ${operation.unitId} is not on the active path`,
        );
      }
      if (removedUnits.has(unit.id)) {
        throw new SurgeryError(
          "CONFLICTING_OPERATION",
          `Unit ${unit.id} is already marked for removal`,
        );
      }
      if (unit.kind === "structural") {
        throw new SurgeryError(
          "UNSUPPORTED_ENTRY",
          `Entry ${unit.primaryEntryId} is structural and cannot be removed in V1`,
        );
      }
      removedUnits.add(unit.id);
      operation.unitId = unit.id;
      affectedIndices.push(unit.startIndex);
      continue;
    }

    const unit =
      unitById.get(operation.anchorUnitId) ??
      entryToUnit.get(operation.anchorUnitId);
    if (!unit) {
      throw new SurgeryError(
        "OFF_PATH_TARGET",
        `Logical unit ${operation.anchorUnitId} is not on the active path`,
      );
    }
    if (!operation.text.trim()) {
      throw new SurgeryError(
        "INVALID_TEXT",
        "Inserted messages cannot be empty",
      );
    }
    const role = operation.kind === "insert-note" ? "context" : operation.role;
    if (role !== "user" && role !== "assistant" && role !== "context") {
      throw new SurgeryError("INVALID_INSERT_ROLE", "Unknown inserted role");
    }
    if (role === "assistant") {
      const identity =
        operation.kind === "insert" ? operation.assistant : undefined;
      if (
        !identity ||
        !identity.api.trim() ||
        !identity.provider.trim() ||
        !identity.model.trim()
      ) {
        throw new SurgeryError(
          "MISSING_MODEL_IDENTITY",
          "Assistant inserts require the active model api, provider, and model identity",
        );
      }
    }
    if (removedUnits.has(unit.id)) {
      throw new SurgeryError(
        "CONFLICTING_OPERATION",
        `Unit ${unit.id} is already marked for removal`,
      );
    }
    if (
      inserts.some(
        (item) =>
          item.anchorUnitId === unit.id && item.position === operation.position,
      )
    ) {
      throw new SurgeryError(
        "CONFLICTING_OPERATION",
        `An inserted ${role} is already staged ${operation.position} of unit ${unit.id}`,
      );
    }
    operation.anchorUnitId = unit.id;
    inserts.push({ ...operation, anchorUnitId: unit.id });
    // Reconstruct the anchor itself so an inserted row can be appended at the
    // logical boundary without relying on an entry that was left on the old branch.
    affectedIndices.push(unit.startIndex);
  }

  for (const key of [
    ...edited.keys(),
    ...reasoningEdited.keys(),
    ...unsignedEdited.keys(),
    ...removedBlocks.keys(),
  ]) {
    const entryId = key.split(":", 1)[0];
    const unit = entryToUnit.get(entryId);
    if (unit && removedUnits.has(unit.id)) {
      throw new SurgeryError(
        "CONFLICTING_OPERATION",
        `Entry ${entryId} is both edited and removed`,
      );
    }
  }
  validateCompactionBoundaries(sourcePath, unitById, removedUnits);

  const earliestAffectedIndex = Math.max(
    0,
    Math.min(...affectedIndices.filter((index) => index < sourcePath.length)),
  );
  validateForwardCompactionReferences(
    sourcePath,
    earliestAffectedIndex,
    removedUnits,
  );
  const prefix = clone(sourcePath.slice(0, earliestAffectedIndex));
  const suffix = sourcePath.slice(earliestAffectedIndex);
  const replay: ReplayItem[] = [];
  const insertBefore = new Map<
    string,
    | Extract<SurgeryOperation, { kind: "insert" }>
    | Extract<SurgeryOperation, { kind: "insert-note" }>
  >();
  const insertAfter = new Map<
    string,
    | Extract<SurgeryOperation, { kind: "insert" }>
    | Extract<SurgeryOperation, { kind: "insert-note" }>
  >();
  for (const insert of inserts) {
    (insert.position === "before" ? insertBefore : insertAfter).set(
      insert.anchorUnitId,
      insert,
    );
  }

  for (const entry of suffix) {
    const unit = entryToUnit.get(entry.id)!;
    if (entry.id === unit.entries[0].id) {
      const before = insertBefore.get(unit.id);
      if (before) replay.push(noteItem(before, "before", unit.id));
    }
    if (!removedUnits.has(unit.id) && isReplayableEntry(entry)) {
      const editedEntry = applyEdits(
        entry,
        edited,
        reasoningEdited,
        unsignedEdited,
        removedBlocks,
      );
      validateAssistantContent(editedEntry);
      replay.push({ kind: "entry", sourceId: entry.id, entry: editedEntry });
    }
    if (entry.id === unit.entries[unit.entries.length - 1].id) {
      const after = insertAfter.get(unit.id);
      if (after) replay.push(noteItem(after, "after", unit.id));
    }
  }

  const candidate = buildCandidate(prefix, replay);
  validateCandidate(candidate);
  validateCandidateContext(candidate);

  const removedEntryIds = units
    .filter((unit) => removedUnits.has(unit.id))
    .flatMap((unit) => unit.entryIds);
  const editedEntryIds = [
    ...edited.keys(),
    ...unsignedEdited.keys(),
    ...removedBlocks.keys(),
  ].map((key) => key.split(":", 1)[0]);
  const unsignedEditedEntryIds = [...unsignedEdited.keys()].map(
    (key) => key.split(":", 1)[0],
  );
  const removedBlockValues = [...removedBlocks.values()];
  const warnings = [
    ...opaqueReferenceWarnings(sourcePath, earliestAffectedIndex),
    ...(unsignedEdited.size > 0 ||
    removedBlockValues.some((block) => block.signatureDetached)
      ? [
          "A provider signature was removed from an assistant block; future provider continuity may fail.",
        ]
      : []),
    ...(inserts.length > 0
      ? [
          "Inserted messages become visible staged rows and active context entries.",
        ]
      : []),
    ...(units.some(
      (unit) => removedUnits.has(unit.id) && unit.kind === "compaction",
    )
      ? [
          "Removing a compaction may make substantially more prior context active.",
        ]
      : []),
  ];
  return {
    sourceSessionId: input.sessionId,
    sourceLeafId: input.leafId,
    sourceEntries,
    sourcePath,
    prefix,
    replay,
    operations: normalized,
    removedEntryIds: [...new Set(removedEntryIds)],
    editedEntryIds: [...new Set(editedEntryIds)],
    editedReasoningEntryIds: [
      ...new Set(
        [...reasoningEdited.keys()].map((key) => key.split(":", 1)[0]),
      ),
    ],
    unsignedEditedEntryIds: [...new Set(unsignedEditedEntryIds)],
    unsignedDetachCount:
      unsignedEdited.size +
      removedBlockValues.filter((block) => block.signatureDetached).length,
    removedBlockCount: removedBlockValues.length,
    removedReasoningCount:
      removedBlockValues.filter((block) => block.blockType === "thinking")
        .length +
      [
        ...reasoningEdited.values(),
        ...[...unsignedEdited.values()]
          .filter((edit) => edit.blockType === "thinking")
          .map((edit) => ({ thinking: edit.text })),
      ].filter((edit) => edit.thinking.trim().length === 0).length,
    insertedEntryIds: inserts.map((_, index) => `insert-${index + 1}`),
    insertedNoteIds: inserts
      .map((insert, index) =>
        insert.kind === "insert-note" || insert.role === "context"
          ? `insert-note-${index + 1}`
          : undefined,
      )
      .filter((id): id is string => id !== undefined),
    warnings,
    earliestAffectedIndex,
  };
}

function claimBlockTarget(
  claimed: Set<string>,
  targetKey: string,
  operation: SurgeryOperation,
): void {
  if (claimed.has(targetKey)) {
    throw new SurgeryError(
      "CONFLICTING_OPERATION",
      `Multiple staged edits target content block ${targetKey}`,
      { targetKey, operationKind: operation.kind },
    );
  }
  claimed.add(targetKey);
}

function isSoleReasoningBlock(
  entry: SessionEntryLike,
  blockIndex: number,
): boolean {
  if (entry.type !== "message" || !isObject(entry.message)) return false;
  const content = (entry.message as Record<string, unknown>).content;
  return Array.isArray(content) && content.length === 1 && blockIndex === 0;
}

function noteItem(
  operation:
    | Extract<SurgeryOperation, { kind: "insert" }>
    | Extract<SurgeryOperation, { kind: "insert-note" }>,
  position: "before" | "after",
  anchorUnitId: string,
): ReplayItem {
  if (operation.kind === "insert-note") {
    return {
      kind: "insert-note",
      sourceId: `insert-note-${operation.anchorUnitId}-${position}`,
      text: operation.text,
      position,
      anchorUnitId,
    };
  }
  return {
    kind: "insert",
    sourceId: `insert-${operation.role}-${operation.anchorUnitId}-${position}`,
    text: operation.text,
    position,
    anchorUnitId,
    role: operation.role,
    assistant: operation.assistant,
  };
}

function applyEdits(
  entry: SessionEntryLike,
  edits: Map<string, { blockIndex: number; text: string }>,
  reasoningEdits: Map<string, { blockIndex: number; thinking: string }>,
  unsignedEdits: Map<
    string,
    { blockIndex: number; blockType: "text" | "thinking"; text: string }
  >,
  removedBlocks: Map<
    string,
    {
      blockIndex: number;
      blockType: "text" | "thinking";
      signatureDetached: boolean;
      unsafe: boolean;
      originalLength: number;
    }
  >,
): SessionEntryLike {
  const entryEdits = [...edits.entries()]
    .filter(([key]) => key.startsWith(`${entry.id}:`))
    .map(([, value]) => value);
  const entryReasoningEdits = [...reasoningEdits.entries()]
    .filter(([key]) => key.startsWith(`${entry.id}:`))
    .map(([, value]) => value);
  const entryUnsignedEdits = [...unsignedEdits.entries()]
    .filter(([key]) => key.startsWith(`${entry.id}:`))
    .map(([, value]) => value);
  const entryRemovedBlocks = [...removedBlocks.entries()]
    .filter(([key]) => key.startsWith(`${entry.id}:`))
    .map(([, value]) => value);
  if (
    entryEdits.length === 0 &&
    entryReasoningEdits.length === 0 &&
    entryUnsignedEdits.length === 0 &&
    entryRemovedBlocks.length === 0
  ) {
    return clone(entry);
  }
  const result = clone(entry);
  if (result.type === "compaction" || result.type === "branch_summary") {
    result.summary = entryEdits[0].text;
    return result;
  }
  if (result.type === "custom_message") {
    result.content = applyMessageEdits(
      result.content,
      entryEdits,
      [],
      [],
      entryRemovedBlocks,
    );
    return result;
  }
  if (isObject(result.message)) {
    const originalMessage = result.message as Record<string, unknown>;
    const nextMessage: Record<string, unknown> = {
      ...originalMessage,
      content: applyMessageEdits(
        originalMessage.content,
        entryEdits,
        entryReasoningEdits,
        entryUnsignedEdits,
        entryRemovedBlocks,
      ),
    };
    if (nextMessage.role === "assistant") {
      nextMessage.usage = zeroUsage();
      delete nextMessage.errorMessage;
      delete nextMessage.error;
      delete nextMessage.rawStopReason;
      delete nextMessage.diagnostics;
      const hasToolCall =
        Array.isArray(nextMessage.content) &&
        nextMessage.content.some(
          (block) => isObject(block) && block.type === "toolCall",
        );
      nextMessage.stopReason = hasToolCall ? "toolUse" : "stop";
    }
    result.message = nextMessage;
  }
  return result;
}

function applyMessageEdits(
  content: unknown,
  textEdits: Array<{ blockIndex: number; text: string }>,
  reasoningEdits: Array<{ blockIndex: number; thinking: string }>,
  unsignedEdits: Array<{
    blockIndex: number;
    blockType: "text" | "thinking";
    text: string;
  }>,
  removedBlocks: Array<{
    blockIndex: number;
    blockType: "text" | "thinking";
  }>,
): unknown {
  if (!Array.isArray(content)) {
    return typeof content === "string"
      ? (textEdits[0]?.text ?? content)
      : content;
  }
  if (
    textEdits.length === 0 &&
    reasoningEdits.length === 0 &&
    unsignedEdits.length === 0 &&
    removedBlocks.length === 0
  ) {
    return content;
  }
  const textByIndex = new Map(
    textEdits.map((edit) => [edit.blockIndex, edit.text]),
  );
  const reasoningByIndex = new Map(
    reasoningEdits.map((edit) => [edit.blockIndex, edit.thinking]),
  );
  const unsignedByIndex = new Map(
    unsignedEdits.map((edit) => [edit.blockIndex, edit]),
  );
  const removedByIndex = new Map(
    removedBlocks.map((block) => [block.blockIndex, block]),
  );
  return content.flatMap((block, index) => {
    const removed = removedByIndex.get(index);
    if (removed && isObject(block) && block.type === removed.blockType) {
      return [];
    }
    if (!isObject(block)) return [block];
    const text = textByIndex.get(index);
    const thinking = reasoningByIndex.get(index);
    const unsigned = unsignedByIndex.get(index);
    if (
      text === undefined &&
      thinking === undefined &&
      unsigned === undefined
    ) {
      return [block];
    }
    const next: Record<string, unknown> = { ...block };
    if (text !== undefined && next.type === "text") next.text = text;
    if (unsigned && next.type === unsigned.blockType) {
      if (
        unsigned.blockType === "thinking" &&
        unsigned.text.trim().length === 0
      ) {
        return [];
      }
      if (unsigned.blockType === "text") {
        next.text = unsigned.text;
        delete next.textSignature;
      } else {
        next.thinking = unsigned.text;
        delete next.thinkingSignature;
      }
    }
    if (thinking !== undefined && next.type === "thinking") {
      if (thinking.trim().length === 0) return [];
      next.thinking = thinking;
      delete next.thinkingSignature;
      delete next.redacted;
    }
    return [next];
  });
}

function validateAssistantContent(entry: SessionEntryLike): void {
  if (entry.type !== "message" || !isObject(entry.message)) return;
  const message = entry.message as Record<string, unknown>;
  if (message.role !== "assistant") return;
  if (Array.isArray(message.content) && message.content.length === 0) {
    throw new SurgeryError(
      "EMPTY_ASSISTANT_CONTENT",
      `Assistant entry ${entry.id} cannot be left without content blocks`,
    );
  }
}

function validateCompactionBoundaries(
  path: SessionEntryLike[],
  unitById: Map<string, LogicalUnit>,
  removedUnits: Set<string>,
): void {
  const pathIds = new Set(path.map((entry) => entry.id));
  for (const entry of path) {
    if (entry.type !== "compaction") continue;
    const first =
      typeof entry.firstKeptEntryId === "string"
        ? entry.firstKeptEntryId
        : undefined;
    if (!first || !pathIds.has(first)) {
      throw new SurgeryError(
        "INVALID_COMPACTION_BOUNDARY",
        `Compaction ${entry.id} references an unresolved firstKeptEntryId`,
      );
    }
    const firstUnit = unitById.get(first);
    if (
      firstUnit &&
      removedUnits.has(firstUnit.id) &&
      !removedUnits.has(entry.id)
    ) {
      throw new SurgeryError(
        "INVALID_COMPACTION_BOUNDARY",
        `Compaction ${entry.id} cannot retain removed boundary entry ${first}`,
      );
    }
  }
}

function validateForwardCompactionReferences(
  path: SessionEntryLike[],
  earliestAffectedIndex: number,
  removedUnits: Set<string>,
): void {
  const indexById = new Map(path.map((entry, index) => [entry.id, index]));
  for (const entry of path) {
    if (entry.type !== "compaction" || removedUnits.has(entry.id)) continue;
    const boundary =
      typeof entry.firstKeptEntryId === "string"
        ? indexById.get(entry.firstKeptEntryId)
        : undefined;
    const compactionIndex = indexById.get(entry.id);
    if (boundary === undefined || compactionIndex === undefined) continue;
    if (
      compactionIndex >= earliestAffectedIndex &&
      boundary > compactionIndex
    ) {
      throw new SurgeryError(
        "UNSUPPORTED_FORWARD_COMPACTION_REFERENCE",
        `Compaction ${entry.id} points into the reconstructed suffix; edit a later entry or remove the compaction first`,
      );
    }
  }
}

function isReplayableEntry(entry: SessionEntryLike): boolean {
  if (entry.type === "session_info") return false;
  if (
    entry.type === "custom" &&
    (entry.customType === "pi-tree-editor.surgery" ||
      entry.customType === "pi-tree-editor.recovery")
  ) {
    return false;
  }
  return true;
}

function buildCandidate(
  prefix: SessionEntryLike[],
  replay: ReplayItem[],
): SessionEntryLike[] {
  const result = clone(prefix);
  const oldToCandidate = new Map(prefix.map((entry) => [entry.id, entry.id]));
  let parentId = result.at(-1)?.id ?? null;
  for (const item of replay) {
    if (item.kind === "insert-note" || item.kind === "insert") {
      const candidateId = `candidate:${item.sourceId}`;
      const entry =
        item.kind === "insert-note" || item.role === "context"
          ? {
              type: "custom_message",
              id: candidateId,
              parentId,
              timestamp: new Date(0).toISOString(),
              customType: "pi-tree-editor.note",
              content: item.text,
              display: true,
              details: {
                anchorUnitId: item.anchorUnitId,
                position: item.position,
                role: "context",
              },
            }
          : {
              type: "message",
              id: candidateId,
              parentId,
              timestamp: new Date(0).toISOString(),
              message:
                item.role === "assistant"
                  ? {
                      role: "assistant",
                      content: [{ type: "text", text: item.text }],
                      api: item.assistant?.api,
                      provider: item.assistant?.provider,
                      model: item.assistant?.model,
                      usage: zeroUsage(),
                      stopReason: "stop",
                    }
                  : { role: "user", content: item.text },
            };
      result.push(entry);
      parentId = candidateId;
      oldToCandidate.set(item.sourceId, candidateId);
      continue;
    }
    const entry = clone(item.entry);
    const candidateId = `candidate:${item.sourceId}`;
    entry.id = candidateId;
    entry.parentId = parentId;
    if (
      entry.type === "compaction" &&
      typeof entry.firstKeptEntryId === "string"
    ) {
      entry.firstKeptEntryId =
        oldToCandidate.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId;
    }
    if (entry.type === "branch_summary" && typeof entry.fromId === "string") {
      entry.fromId = oldToCandidate.get(entry.fromId) ?? entry.fromId;
    }
    if (entry.type === "label" && typeof entry.targetId === "string") {
      entry.targetId = oldToCandidate.get(entry.targetId) ?? entry.targetId;
    }
    result.push(entry);
    oldToCandidate.set(item.sourceId, candidateId);
    parentId = candidateId;
  }
  return result;
}

function validateCandidateContext(entries: SessionEntryLike[]): void {
  try {
    buildSessionContext(entries as never, entries.at(-1)?.id ?? null);
  } catch (error) {
    throw new SurgeryError(
      "INVALID_CONTEXT",
      `Candidate session context could not be built: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function zeroUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function opaqueReferenceWarnings(
  path: SessionEntryLike[],
  earliestAffectedIndex: number,
): string[] {
  const sourceIds = path.slice(earliestAffectedIndex).map((entry) => entry.id);
  const warnings: string[] = [];
  for (const entry of path.slice(earliestAffectedIndex)) {
    if (entry.type !== "custom" || entry.data === undefined) continue;
    const encoded = JSON.stringify(entry.data);
    if (sourceIds.some((id) => encoded.includes(id))) {
      warnings.push(
        `Opaque custom entry ${entry.id} contains a source ID; nested references were not remapped.`,
      );
    }
  }
  return warnings;
}

function validateCandidate(entries: SessionEntryLike[]): void {
  const byId = indexEntries(entries);
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw new SurgeryError(
        "INVALID_PARENT",
        `Entry ${entry.id} has a missing parent`,
      );
    }
    if (
      entry.type === "compaction" &&
      typeof entry.firstKeptEntryId === "string" &&
      !byId.has(entry.firstKeptEntryId)
    ) {
      throw new SurgeryError(
        "INVALID_COMPACTION_BOUNDARY",
        `Compaction ${entry.id} has an unresolved candidate boundary`,
      );
    }
  }
}
