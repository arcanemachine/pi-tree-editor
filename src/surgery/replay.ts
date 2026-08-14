import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  SurgeryError,
  clone,
  type ReplayItem,
  type SessionEntryLike,
  type SurgeryPlan,
} from "./types.js";

export type SessionManagerAdapter = {
  getEntries(): SessionEntryLike[];
  getSessionId?(): string;
  getLeafId(): string | null;
  branch(id: string): void;
  resetLeaf(): void;
  appendMessage(message: unknown): string;
  appendThinkingLevelChange?(level: string): string;
  appendModelChange?(provider: string, modelId: string): string;
  appendCompaction?(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    usage?: unknown,
  ): string;
  appendCustomEntry?(customType: string, data?: unknown): string;
  appendCustomMessageEntry?(
    customType: string,
    content: unknown,
    display: boolean,
    details?: unknown,
  ): string;
  appendSessionInfo?(name: string): string;
  appendLabelChange?(targetId: string, label: string | undefined): string;
  branchWithSummary?(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: unknown,
  ): string;
  buildSessionContext?(): unknown;
};

export type ApplyResult = {
  auditEntryId: string;
  candidateLeafId: string;
  oldToNew: Record<string, string>;
  insertedEntryIds: string[];
  insertedNoteIds: string[];
  recoveryEntryId?: string;
};

const AUDIT_TYPE = "pi-tree-editor.surgery";
const NOTE_TYPE = "pi-tree-editor.note";
const RECOVERY_TYPE = "pi-tree-editor.recovery";

export async function applySurgery(
  manager: SessionManagerAdapter,
  plan: SurgeryPlan,
  agentSession?: Pick<AgentSession, "navigateTree">,
): Promise<ApplyResult> {
  const originalLeaf = manager.getLeafId();
  if (
    plan.sourceSessionId &&
    manager.getSessionId &&
    manager.getSessionId() !== plan.sourceSessionId
  ) {
    throw new SurgeryError(
      "SESSION_CHANGED",
      "The active session changed while the tree editor was open. Reopen /tree and stage the edit again.",
    );
  }
  if (originalLeaf !== plan.sourceLeafId) {
    throw new SurgeryError(
      "SESSION_CHANGED",
      "The session changed while the tree editor was open. Reopen /tree and stage the edit again.",
    );
  }
  const currentEntries = manager.getEntries();
  for (const source of plan.sourcePath) {
    const current = currentEntries.find((entry) => entry.id === source.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(source)) {
      throw new SurgeryError(
        "SESSION_CHANGED",
        "A source entry changed while editing",
      );
    }
  }

  validateCapabilities(manager, plan);
  const oldToNew: Record<string, string> = {};
  const insertedEntryIds: string[] = [];
  const insertedNoteIds: string[] = [];
  for (const entry of plan.prefix) oldToNew[entry.id] = entry.id;
  let candidateLeafId: string | null = plan.prefix.at(-1)?.id ?? null;
  try {
    if (candidateLeafId) manager.branch(candidateLeafId);
    else manager.resetLeaf();

    for (const item of plan.replay) {
      if (item.kind === "insert-note" || item.kind === "insert") {
        const role = item.kind === "insert-note" ? "context" : item.role;
        let id: string;
        if (role === "context") {
          const append = manager.appendCustomMessageEntry;
          if (!append)
            throw new SurgeryError(
              "MISSING_CAPABILITY",
              "Pi cannot append custom context messages",
            );
          id = append.call(manager, NOTE_TYPE, item.text, true, {
            anchorUnitId: item.anchorUnitId,
            position: item.position,
            role,
          });
          insertedNoteIds.push(id);
        } else if (role === "user") {
          if (!manager.appendMessage)
            throw new SurgeryError(
              "MISSING_CAPABILITY",
              "Pi cannot append inserted user messages",
            );
          id = manager.appendMessage.call(manager, {
            role: "user",
            content: item.text,
          });
        } else {
          const identity = item.kind === "insert" ? item.assistant : undefined;
          if (
            !identity ||
            !identity.api ||
            !identity.provider ||
            !identity.model
          ) {
            throw new SurgeryError(
              "MISSING_MODEL_IDENTITY",
              "Assistant inserts require the active model api, provider, and model identity",
            );
          }
          if (!manager.appendMessage)
            throw new SurgeryError(
              "MISSING_CAPABILITY",
              "Pi cannot append inserted assistant messages",
            );
          id = manager.appendMessage.call(manager, {
            role: "assistant",
            content: item.text,
            api: identity.api,
            provider: identity.provider,
            model: identity.model,
            usage: zeroUsage(),
            stopReason: "stop",
          });
        }
        oldToNew[item.sourceId] = id;
        insertedEntryIds.push(id);
        candidateLeafId = id;
        continue;
      }

      const entry = remapEntry(item.entry, oldToNew);
      const id = appendEntry(manager, entry);
      oldToNew[item.sourceId] = id;
      candidateLeafId = id;
    }

    if (!candidateLeafId) {
      throw new SurgeryError(
        "EMPTY_RESULT",
        "The edit removed every reconstructable entry",
      );
    }
    const appendAudit = manager.appendCustomEntry;
    if (!appendAudit)
      throw new SurgeryError(
        "MISSING_CAPABILITY",
        "Pi cannot append audit entries",
      );
    const auditEntryId = appendAudit.call(manager, AUDIT_TYPE, {
      schemaVersion: 1,
      sourceLeafId: plan.sourceLeafId,
      reconstructedLeafId: candidateLeafId,
      earliestAffectedIndex: plan.earliestAffectedIndex,
      operations: plan.operations.map((operation) =>
        operation.kind === "edit-text"
          ? {
              kind: operation.kind,
              entryId: operation.entryId,
              blockIndex: operation.blockIndex,
            }
          : operation.kind === "edit-reasoning"
            ? {
                kind: operation.kind,
                entryId: operation.entryId,
                blockIndex: operation.blockIndex,
                thinkingLength: operation.thinking.length,
                removesBlock: operation.thinking.trim().length === 0,
              }
            : operation.kind === "insert-note"
              ? {
                  kind: "insert",
                  role: "context",
                  anchorUnitId: operation.anchorUnitId,
                  position: operation.position,
                  textLength: operation.text.length,
                }
              : operation.kind === "insert"
                ? {
                    kind: operation.kind,
                    role: operation.role,
                    anchorUnitId: operation.anchorUnitId,
                    position: operation.position,
                    textLength: operation.text.length,
                  }
                : operation,
      ),
      oldToNew,
      removedEntryIds: plan.removedEntryIds,
      editedEntryIds: plan.editedEntryIds,
      editedReasoningEntryIds: plan.editedReasoningEntryIds,
      removedReasoningCount: plan.removedReasoningCount,
      insertedEntryIds,
      insertedNoteIds,
      warnings: plan.warnings,
    });
    candidateLeafId = auditEntryId;

    if (agentSession) {
      // Native navigation must observe a different current leaf so it rebuilds
      // AgentSession state and emits the normal tree lifecycle events.
      if (originalLeaf) manager.branch(originalLeaf);
      else manager.resetLeaf();
      const result = await agentSession.navigateTree(auditEntryId, {
        summarize: false,
      });
      if (result.cancelled || result.aborted) {
        throw new SurgeryError(
          "NAVIGATION_CANCELLED",
          "Native session navigation was cancelled",
        );
      }
    }
    return {
      auditEntryId,
      candidateLeafId,
      oldToNew,
      insertedEntryIds,
      insertedNoteIds,
    };
  } catch (error) {
    let recoveryEntryId: string | undefined;
    try {
      if (originalLeaf) manager.branch(originalLeaf);
      else manager.resetLeaf();
      if (manager.appendCustomEntry) {
        recoveryEntryId = manager.appendCustomEntry.call(
          manager,
          RECOVERY_TYPE,
          {
            schemaVersion: 1,
            sourceLeafId: originalLeaf,
            failedCandidateLeafId: candidateLeafId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } catch {
      // The original branch remains the best available recovery point.
    }
    if (error instanceof SurgeryError) {
      error.details = {
        ...(typeof error.details === "object" && error.details
          ? error.details
          : {}),
        recoveryEntryId,
      };
      throw error;
    }
    throw new SurgeryError(
      "APPLY_FAILED",
      `Conversation reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, recoveryEntryId },
    );
  }
}

function remapEntry(
  entry: SessionEntryLike,
  oldToNew: Record<string, string>,
): SessionEntryLike {
  const result = clone(entry);
  result.parentId = result.parentId
    ? (oldToNew[result.parentId] ?? result.parentId)
    : null;
  if (
    result.type === "compaction" &&
    typeof result.firstKeptEntryId === "string"
  ) {
    const mapped = oldToNew[result.firstKeptEntryId];
    if (!mapped) {
      throw new SurgeryError(
        "INVALID_COMPACTION_BOUNDARY",
        `No reconstructed entry exists for compaction boundary ${result.firstKeptEntryId}`,
      );
    }
    result.firstKeptEntryId = mapped;
  }
  if (result.type === "branch_summary" && typeof result.fromId === "string") {
    result.fromId = oldToNew[result.fromId] ?? result.fromId;
  }
  if (result.type === "label" && typeof result.targetId === "string") {
    result.targetId = oldToNew[result.targetId] ?? result.targetId;
  }
  return result;
}

function appendEntry(
  manager: SessionManagerAdapter,
  entry: SessionEntryLike,
): string {
  switch (entry.type) {
    case "message":
      return manager.appendMessage(entry.message);
    case "thinking_level_change":
      if (!manager.appendThinkingLevelChange) throw missing(entry.type);
      return manager.appendThinkingLevelChange(String(entry.thinkingLevel));
    case "model_change":
      if (!manager.appendModelChange) throw missing(entry.type);
      return manager.appendModelChange(
        String(entry.provider),
        String(entry.modelId),
      );
    case "compaction":
      if (!manager.appendCompaction) throw missing(entry.type);
      return manager.appendCompaction(
        String(entry.summary),
        String(entry.firstKeptEntryId),
        Number(entry.tokensBefore ?? 0),
        entry.details,
        Boolean(entry.fromHook),
        entry.usage,
      );
    case "branch_summary":
      if (!manager.branchWithSummary) {
        throw missing(entry.type);
      }
      return manager.branchWithSummary(
        manager.getLeafId(),
        String(entry.summary),
        entry.details,
        Boolean(entry.fromHook),
        entry.usage,
      );
    case "custom":
      if (!manager.appendCustomEntry) throw missing(entry.type);
      return manager.appendCustomEntry(String(entry.customType), entry.data);
    case "custom_message":
      if (!manager.appendCustomMessageEntry) throw missing(entry.type);
      return manager.appendCustomMessageEntry(
        String(entry.customType),
        entry.content,
        Boolean(entry.display),
        entry.details,
      );
    case "session_info":
      if (!manager.appendSessionInfo) throw missing(entry.type);
      return manager.appendSessionInfo(String(entry.name ?? ""));
    case "label":
      if (!manager.appendLabelChange) throw missing(entry.type);
      return manager.appendLabelChange(
        String(entry.targetId),
        entry.label as string | undefined,
      );
    default:
      throw missing(entry.type);
  }
}

function validateCapabilities(
  manager: SessionManagerAdapter,
  plan: SurgeryPlan,
): void {
  const missingCapabilities = new Set<string>();
  const requireCapability = (name: string, available: unknown) => {
    if (typeof available !== "function") missingCapabilities.add(name);
  };
  requireCapability("appendCustomEntry", manager.appendCustomEntry);
  for (const item of plan.replay) {
    if (item.kind === "insert-note" || item.kind === "insert") {
      if (item.kind === "insert-note" || item.role === "context") {
        requireCapability(
          "appendCustomMessageEntry",
          manager.appendCustomMessageEntry,
        );
      } else {
        requireCapability("appendMessage", manager.appendMessage);
      }
      continue;
    }
    switch (item.entry.type) {
      case "message":
        requireCapability("appendMessage", manager.appendMessage);
        break;
      case "thinking_level_change":
        requireCapability(
          "appendThinkingLevelChange",
          manager.appendThinkingLevelChange,
        );
        break;
      case "model_change":
        requireCapability("appendModelChange", manager.appendModelChange);
        break;
      case "compaction":
        requireCapability("appendCompaction", manager.appendCompaction);
        break;
      case "branch_summary":
        requireCapability("branchWithSummary", manager.branchWithSummary);
        break;
      case "custom":
        requireCapability("appendCustomEntry", manager.appendCustomEntry);
        break;
      case "custom_message":
        requireCapability(
          "appendCustomMessageEntry",
          manager.appendCustomMessageEntry,
        );
        break;
      case "session_info":
        requireCapability("appendSessionInfo", manager.appendSessionInfo);
        break;
      case "label":
        requireCapability("appendLabelChange", manager.appendLabelChange);
        break;
      default:
        missingCapabilities.add(`replay:${item.entry.type}`);
    }
  }
  if (missingCapabilities.size > 0) {
    throw new SurgeryError(
      "MISSING_CAPABILITY",
      `Pi cannot apply this plan; missing ${[...missingCapabilities].join(", ")}`,
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

function missing(type: string): SurgeryError {
  return new SurgeryError(
    "MISSING_CAPABILITY",
    `Pi cannot replay session entry type ${type}`,
  );
}
