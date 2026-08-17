import {
  SurgeryError,
  type LogicalUnit,
  type SessionEntryLike,
  type TextBlockLocation,
  type TreeMessage,
  isObject,
} from "./types.js";

function message(entry: SessionEntryLike): TreeMessage | undefined {
  return entry.type === "message" && isObject(entry.message)
    ? (entry.message as TreeMessage)
    : undefined;
}

export function toolCallIds(entry: SessionEntryLike): string[] {
  const msg = message(entry);
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content))
    return [];
  return msg.content
    .filter(
      (block): block is { type: "toolCall"; id: string } =>
        isObject(block) &&
        block.type === "toolCall" &&
        typeof block.id === "string",
    )
    .map((block) => block.id);
}

export function toolResultId(entry: SessionEntryLike): string | undefined {
  const msg = message(entry);
  if (!msg || msg.role !== "toolResult") return undefined;
  return typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
}

export function buildLogicalUnits(path: SessionEntryLike[]): {
  units: LogicalUnit[];
  issues: string[];
} {
  const units: LogicalUnit[] = [];
  const issues: string[] = [];
  const claimedToolResults = new Set<string>();
  let index = 0;

  while (index < path.length) {
    const entry = path[index];
    const calls = toolCallIds(entry);
    if (calls.length > 0) {
      if (new Set(calls).size !== calls.length) {
        issues.push(
          `Assistant entry ${entry.id} contains duplicate tool call IDs`,
        );
      }
      const callSet = new Set(calls);
      const grouped = [entry];
      const resultIds: string[] = [];
      let cursor = index + 1;
      while (cursor < path.length && resultIds.length < calls.length) {
        const candidate = path[cursor];
        const resultId = toolResultId(candidate);
        if (!resultId) break;
        if (!callSet.has(resultId)) {
          issues.push(
            `Tool result ${candidate.id} does not belong to assistant entry ${entry.id}`,
          );
        } else if (claimedToolResults.has(candidate.id)) {
          issues.push(`Tool result entry ${candidate.id} is repeated`);
        } else if (resultIds.includes(resultId)) {
          issues.push(
            `Tool result ID ${resultId} appears more than once for assistant entry ${entry.id}`,
          );
          grouped.push(candidate);
          resultIds.push(resultId);
          claimedToolResults.add(candidate.id);
        } else {
          grouped.push(candidate);
          resultIds.push(resultId);
          claimedToolResults.add(candidate.id);
        }
        cursor += 1;
      }
      if (resultIds.length !== calls.length) {
        issues.push(
          `Assistant entry ${entry.id} has ${calls.length} tool call(s) but ${resultIds.length} adjacent result(s)`,
        );
      }
      units.push({
        id: entry.id,
        kind: "tool-exchange",
        entries: grouped,
        entryIds: grouped.map((item) => item.id),
        primaryEntryId: entry.id,
        toolCallIds: calls,
        startIndex: index,
        endIndex: index + grouped.length - 1,
      });
      index += grouped.length;
      continue;
    }

    const resultId = toolResultId(entry);
    if (resultId && !claimedToolResults.has(entry.id)) {
      issues.push(
        `Tool result entry ${entry.id} has no adjacent assistant tool call`,
      );
    }

    const kind =
      entry.type === "compaction"
        ? "compaction"
        : entry.type === "branch_summary"
          ? "branch-summary"
          : entry.type === "custom_message"
            ? "custom-message"
            : entry.type === "message"
              ? "message"
              : "structural";
    units.push({
      id: entry.id,
      kind,
      entries: [entry],
      entryIds: [entry.id],
      primaryEntryId: entry.id,
      toolCallIds: [],
      startIndex: index,
      endIndex: index,
    });
    index += 1;
  }

  return { units, issues };
}

export type BlockEligibilityReason =
  | "provider-signed"
  | "redacted"
  | "tool-associated"
  | "unsupported";

export type ReasoningBlockLocation = {
  entryId: string;
  blockIndex: number;
  text: string;
  safe: boolean;
  reason?: BlockEligibilityReason;
  signedTarget?: boolean;
};

export type AssistantContentBlockLocation = {
  entryId: string;
  blockIndex: number;
  blockType: "text" | "thinking";
  text: string;
};

export type ReasoningEligibility = {
  eligible: boolean;
  reason?: BlockEligibilityReason;
};

export type TextBlockEligibility = {
  eligible: boolean;
  reason?: BlockEligibilityReason;
  signedTarget?: boolean;
};

function assistantContent(entry: SessionEntryLike): unknown[] | undefined {
  if (entry.type !== "message" || !isObject(entry.message)) return undefined;
  const message = entry.message as TreeMessage;
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  return message.content;
}

function signaturePresent(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function assistantBlockIssue(
  content: unknown[],
): BlockEligibilityReason | undefined {
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== "string") {
      return "unsupported";
    }
    if (block.type === "thinking") {
      if (typeof block.thinking !== "string") return "unsupported";
      if (
        "thinkingSignature" in block &&
        typeof block.thinkingSignature !== "string"
      ) {
        return "unsupported";
      }
      if (block.redacted === true) return "redacted";
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") return "unsupported";
      if ("textSignature" in block && typeof block.textSignature !== "string") {
        return "unsupported";
      }
      if (block.redacted === true) return "redacted";
      continue;
    }
    if (block.type === "toolCall") return "tool-associated";
    return "unsupported";
  }
  return undefined;
}

export function reasoningEligibility(
  entry: SessionEntryLike,
): ReasoningEligibility {
  if (entry.type === "message" && isObject(entry.message)) {
    const message = entry.message as TreeMessage;
    if (message.role === "assistant" && typeof message.content === "string") {
      return { eligible: true };
    }
  }
  const content = assistantContent(entry);
  if (!content) return { eligible: false, reason: "unsupported" };
  const issue = assistantBlockIssue(content);
  if (issue) return { eligible: false, reason: issue };
  for (const block of content) {
    if (
      isObject(block) &&
      ((block.type === "thinking" &&
        signaturePresent(block.thinkingSignature)) ||
        (block.type === "text" && signaturePresent(block.textSignature)))
    ) {
      return { eligible: false, reason: "provider-signed" };
    }
  }
  return { eligible: true };
}

function assistantBlockAt(
  entry: SessionEntryLike,
  blockIndex: number,
): Record<string, unknown> | undefined {
  const content = assistantContent(entry);
  const block = content?.[blockIndex];
  return isObject(block) ? block : undefined;
}

export function textBlockEligibility(
  entry: SessionEntryLike,
  blockIndex: number,
): TextBlockEligibility {
  const blocks = editableTextBlocks(entry);
  const target = blocks.find((block) => block.blockIndex === blockIndex);
  if (!target) return { eligible: false, reason: "unsupported" };
  const msg = message(entry);
  if (!msg || msg.role !== "assistant") return { eligible: true };
  if (typeof msg.content === "string") return { eligible: true };
  const content = assistantContent(entry);
  if (!content) return { eligible: false, reason: "unsupported" };
  const issue = assistantBlockIssue(content);
  if (issue) return { eligible: false, reason: issue };
  const block = assistantBlockAt(entry, blockIndex);
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    return { eligible: false, reason: "unsupported" };
  }
  const signedTarget = signaturePresent(block.textSignature);
  return signedTarget
    ? { eligible: false, reason: "provider-signed", signedTarget: true }
    : { eligible: true };
}

export function reasoningBlockEligibility(
  entry: SessionEntryLike,
  blockIndex: number,
): ReasoningEligibility & { signedTarget?: boolean } {
  const content = assistantContent(entry);
  const block = assistantBlockAt(entry, blockIndex);
  if (!content || !block || block.type !== "thinking") {
    return { eligible: false, reason: "unsupported" };
  }
  if (typeof block.thinking !== "string") {
    return { eligible: false, reason: "unsupported" };
  }
  const issue = assistantBlockIssue(content);
  if (issue) return { eligible: false, reason: issue };
  const signedTarget = signaturePresent(block.thinkingSignature);
  if (signedTarget) {
    return { eligible: false, reason: "provider-signed", signedTarget: true };
  }
  for (const candidate of content) {
    if (
      isObject(candidate) &&
      ((candidate.type === "thinking" &&
        signaturePresent(candidate.thinkingSignature)) ||
        (candidate.type === "text" &&
          signaturePresent(candidate.textSignature)))
    ) {
      return { eligible: false, reason: "provider-signed" };
    }
  }
  return { eligible: true };
}

export function assistantContentBlocks(
  entry: SessionEntryLike,
): AssistantContentBlockLocation[] {
  const content = assistantContent(entry);
  if (!content || content.length <= 1 || assistantBlockIssue(content)) {
    return [];
  }
  return content.flatMap<AssistantContentBlockLocation>((block, blockIndex) => {
    if (!isObject(block)) return [];
    if (block.type === "text" && typeof block.text === "string") {
      return [
        {
          entryId: entry.id,
          blockIndex,
          blockType: "text" as const,
          text: block.text,
        },
      ];
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      return [
        {
          entryId: entry.id,
          blockIndex,
          blockType: "thinking" as const,
          text: block.thinking,
        },
      ];
    }
    return [];
  });
}

export function reasoningBlocks(
  entry: SessionEntryLike,
): ReasoningBlockLocation[] {
  const content = assistantContent(entry);
  if (!content) return [];
  return content.flatMap((block, blockIndex) => {
    if (
      !isObject(block) ||
      block.type !== "thinking" ||
      typeof block.thinking !== "string"
    ) {
      return [];
    }
    const eligibility = reasoningBlockEligibility(entry, blockIndex);
    return [
      {
        entryId: entry.id,
        blockIndex,
        text: block.thinking,
        safe: eligibility.eligible,
        reason: eligibility.reason,
        signedTarget: eligibility.signedTarget,
      },
    ];
  });
}

export function editableTextBlocks(
  entry: SessionEntryLike,
): TextBlockLocation[] {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return typeof entry.summary === "string"
      ? [
          {
            entryId: entry.id,
            blockIndex: 0,
            text: entry.summary,
            path: "summary",
          },
        ]
      : [];
  }

  if (entry.type === "custom_message") {
    return contentTextBlocks(entry.id, entry.content, "custom_message");
  }

  const msg = message(entry);
  if (
    !msg ||
    (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "custom")
  ) {
    return [];
  }
  return contentTextBlocks(entry.id, msg.content, "message");
}

function contentTextBlocks(
  entryId: string,
  content: unknown,
  path: "message" | "custom_message",
): TextBlockLocation[] {
  if (typeof content === "string") {
    return [{ entryId, blockIndex: 0, text: content, path }];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, blockIndex) =>
    isObject(block) && block.type === "text" && typeof block.text === "string"
      ? [{ entryId, blockIndex, text: block.text, path }]
      : [],
  );
}

export function assertEditable(entry: SessionEntryLike): void {
  if (editableTextBlocks(entry).length === 0) {
    throw new SurgeryError(
      "UNEDITABLE_ENTRY",
      `Entry ${entry.id} has no supported text block`,
    );
  }
  const msg = message(entry);
  if (msg?.role === "toolResult") {
    throw new SurgeryError(
      "TOOL_CONTENT_PROTECTED",
      "Tool results cannot be edited",
    );
  }
  if (toolCallIds(entry).length > 0) {
    throw new SurgeryError(
      "TOOL_CONTENT_PROTECTED",
      "Assistant tool exchanges cannot be edited internally",
    );
  }
}
