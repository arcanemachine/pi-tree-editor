export type JsonObject = Record<string, unknown>;

export type SessionEntryLike = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  [key: string]: unknown;
};

export type TreeMessage = {
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

export type TextBlockLocation = {
  entryId: string;
  blockIndex: number;
  text: string;
  path: "message" | "custom_message" | "summary";
};

export type InsertRole = "user" | "assistant" | "context";

export type AssistantModelIdentity = {
  api: string;
  provider: string;
  model: string;
};

export type InsertOperation = {
  kind: "insert";
  anchorUnitId: string;
  position: "before" | "after";
  role: InsertRole;
  text: string;
  assistant?: AssistantModelIdentity;
};

/** Legacy context-note input retained for standalone callers of the V1 API. */
export type InsertNoteOperation = {
  kind: "insert-note";
  anchorUnitId: string;
  position: "before" | "after";
  text: string;
};

export type UnsignedEditOperation = {
  kind: "edit-unsigned";
  entryId: string;
  blockIndex: number;
  blockType: "text" | "thinking";
  text: string;
};

export type RemoveBlockOperation = {
  kind: "remove-block";
  entryId: string;
  blockIndex: number;
  blockType: "text" | "thinking";
  signatureDetached: boolean;
  unsafe: boolean;
};

export type SurgeryOperation =
  | {
      kind: "edit-text";
      entryId: string;
      blockIndex?: number;
      text: string;
    }
  | {
      kind: "edit-reasoning";
      entryId: string;
      blockIndex: number;
      thinking: string;
    }
  | UnsignedEditOperation
  | RemoveBlockOperation
  | { kind: "remove-unit"; unitId: string }
  | InsertOperation
  | InsertNoteOperation;

export type LogicalUnitKind =
  | "message"
  | "tool-exchange"
  | "compaction"
  | "branch-summary"
  | "custom-message"
  | "structural";

export type LogicalUnit = {
  id: string;
  kind: LogicalUnitKind;
  entries: SessionEntryLike[];
  entryIds: string[];
  primaryEntryId: string;
  toolCallIds: string[];
  startIndex: number;
  endIndex: number;
};

export type ReplayItem =
  | { kind: "entry"; sourceId: string; entry: SessionEntryLike }
  | {
      kind: "insert";
      sourceId: string;
      text: string;
      position: "before" | "after";
      anchorUnitId: string;
      role: InsertRole;
      assistant?: AssistantModelIdentity;
    }
  | {
      kind: "insert-note";
      sourceId: string;
      text: string;
      position: "before" | "after";
      anchorUnitId: string;
    };

export type SurgeryPlan = {
  sourceSessionId?: string;
  sourceLeafId: string;
  sourceEntries: SessionEntryLike[];
  sourcePath: SessionEntryLike[];
  prefix: SessionEntryLike[];
  replay: ReplayItem[];
  operations: SurgeryOperation[];
  removedEntryIds: string[];
  editedEntryIds: string[];
  editedReasoningEntryIds: string[];
  unsignedEditedEntryIds: string[];
  unsignedDetachCount: number;
  removedBlockCount: number;
  removedReasoningCount: number;
  insertedEntryIds: string[];
  insertedNoteIds: string[];
  warnings: string[];
  earliestAffectedIndex: number;
};

export class SurgeryError extends Error {
  readonly code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SurgeryError";
    this.code = code;
    this.details = details;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
