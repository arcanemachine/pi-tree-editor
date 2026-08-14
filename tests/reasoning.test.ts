import { describe, expect, it } from "vitest";
import { auditPreview } from "../src/audit.js";
import {
  reasoningBlockEligibility,
  reasoningBlocks,
  reasoningEligibility,
  textBlockEligibility,
} from "../src/surgery/logical-units.js";
import { planSurgery } from "../src/surgery/planner.js";
import type { SessionEntryLike } from "../src/surgery/types.js";

function assistant(content: unknown[]): SessionEntryLike {
  return {
    type: "message",
    id: "assistant",
    parentId: null,
    timestamp: "old",
    message: {
      role: "assistant",
      content,
      stopReason: "stop",
      timestamp: 0,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

describe("reasoning surgery", () => {
  it("keeps plain-string assistant text editable without making it reasoning", () => {
    const entries = [
      {
        ...assistant([]),
        message: {
          role: "assistant",
          content: "legacy answer",
          stopReason: "stop",
          timestamp: 0,
        },
      },
    ];
    expect(reasoningEligibility(entries[0]!)).toEqual({ eligible: true });
    expect(reasoningBlocks(entries[0]!)).toEqual([]);
    const plan = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        { kind: "edit-text", entryId: "assistant", text: "changed" },
      ],
    });
    const replay = plan.replay.find((item) => item.kind === "entry");
    if (replay?.kind !== "entry") throw new Error("expected replay entry");
    expect((replay.entry.message as { content: unknown }).content).toBe(
      "changed",
    );
  });

  it("edits safe reasoning exactly while preserving surrounding blocks", () => {
    const entries = [
      assistant([
        { type: "thinking", thinking: "inspect repository" },
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "verify result" },
      ]),
    ];
    expect(reasoningEligibility(entries[0]!)).toEqual({ eligible: true });
    expect(
      reasoningBlocks(entries[0]).map((block) => block.blockIndex),
    ).toEqual([0, 2]);
    const original = structuredClone(entries);
    const plan = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        {
          kind: "edit-reasoning",
          entryId: "assistant",
          blockIndex: 2,
          thinking: "verify changed result",
        },
      ],
    });
    const replay = plan.replay.find((item) => item.kind === "entry");
    expect(replay?.kind).toBe("entry");
    if (replay?.kind !== "entry") throw new Error("expected replay entry");
    expect((replay.entry.message as { content: unknown }).content).toEqual([
      { type: "thinking", thinking: "inspect repository" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "verify changed result" },
    ]);
    expect(entries).toEqual(original);
    expect(plan.editedReasoningEntryIds).toEqual(["assistant"]);
    expect(plan.removedReasoningCount).toBe(0);
    expect(auditPreview(plan)).toContain("Change 1 reasoning entry");
  });

  it("rejects removing the sole reasoning content block", () => {
    const entries = [
      assistant([{ type: "thinking", thinking: "only thought" }]),
    ];
    expect(() =>
      planSurgery({
        entries,
        leafId: "assistant",
        operations: [
          {
            kind: "edit-reasoning",
            entryId: "assistant",
            blockIndex: 0,
            thinking: "",
          },
        ],
      }),
    ).toThrow("only content block");
  });

  it("removes only an empty reasoning block", () => {
    const entries = [
      assistant([
        { type: "thinking", thinking: "remove me" },
        { type: "text", text: "keep answer" },
        { type: "thinking", thinking: "keep me" },
      ]),
    ];
    const plan = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        {
          kind: "edit-reasoning",
          entryId: "assistant",
          blockIndex: 0,
          thinking: "",
        },
      ],
    });
    const replay = plan.replay.find((item) => item.kind === "entry");
    if (replay?.kind !== "entry") throw new Error("expected replay entry");
    expect((replay.entry.message as { content: unknown }).content).toEqual([
      { type: "text", text: "keep answer" },
      { type: "thinking", thinking: "keep me" },
    ]);
    expect(plan.removedReasoningCount).toBe(1);
    expect(auditPreview(plan)).toContain("Remove 1 reasoning block");
  });

  it("edits an unsigned answer beside signed reasoning without touching the signature", () => {
    const entries = [
      assistant([
        { type: "text", text: "answer" },
        {
          type: "thinking",
          thinking: "signed thought",
          thinkingSignature: "sig",
        },
      ]),
    ];
    expect(textBlockEligibility(entries[0]!, 0)).toEqual({ eligible: true });
    expect(reasoningBlockEligibility(entries[0]!, 1)).toMatchObject({
      eligible: false,
      reason: "provider-signed",
    });
    const plan = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        {
          kind: "edit-text",
          entryId: "assistant",
          blockIndex: 0,
          text: "changed",
        },
      ],
    });
    const replay = plan.replay.find((item) => item.kind === "entry");
    if (replay?.kind !== "entry") throw new Error("expected replay entry");
    expect((replay.entry.message as { content: unknown }).content).toEqual([
      { type: "text", text: "changed" },
      {
        type: "thinking",
        thinking: "signed thought",
        thinkingSignature: "sig",
      },
    ]);
  });

  it("edits an unsigned answer beside another signed text block", () => {
    const entries = [
      assistant([
        { type: "text", text: "target" },
        { type: "text", text: "signed", textSignature: "sig" },
      ]),
    ];
    expect(textBlockEligibility(entries[0]!, 0)).toEqual({ eligible: true });
    expect(textBlockEligibility(entries[0]!, 1)).toMatchObject({
      eligible: false,
      signedTarget: true,
    });
    const plan = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        { kind: "edit-text", entryId: "assistant", blockIndex: 0, text: "new" },
      ],
    });
    const replay = plan.replay.find((item) => item.kind === "entry");
    if (replay?.kind !== "entry") throw new Error("expected replay entry");
    expect((replay.entry.message as { content: unknown }).content).toEqual([
      { type: "text", text: "new" },
      { type: "text", text: "signed", textSignature: "sig" },
    ]);
  });

  it("detaches only a directly signed answer signature, including unchanged text", () => {
    const entries = [
      assistant([
        { type: "text", text: "target", textSignature: "sig" },
        { type: "thinking", thinking: "keep", thinkingSignature: "keep-sig" },
      ]),
    ];
    const plan = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        {
          kind: "edit-unsigned",
          entryId: "assistant",
          blockIndex: 0,
          blockType: "text",
          text: "target",
        },
      ],
    });
    expect(plan.warnings).toContain(
      "A provider signature was removed from an assistant block; future provider continuity may fail.",
    );
    expect(plan.unsignedDetachCount).toBe(1);
    const replay = plan.replay.find((item) => item.kind === "entry");
    if (replay?.kind !== "entry") throw new Error("expected replay entry");
    expect((replay.entry.message as { content: unknown }).content).toEqual([
      { type: "text", text: "target" },
      { type: "thinking", thinking: "keep", thinkingSignature: "keep-sig" },
    ]);
  });

  it("detaches signed reasoning or removes it while preserving other content", () => {
    const entries = [
      assistant([
        { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
        { type: "text", text: "answer", textSignature: "answer-sig" },
      ]),
    ];
    expect(reasoningBlockEligibility(entries[0]!, 0)).toMatchObject({
      signedTarget: true,
    });
    const unchanged = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        {
          kind: "edit-unsigned",
          entryId: "assistant",
          blockIndex: 0,
          blockType: "thinking",
          text: "signed",
        },
      ],
    });
    const unchangedReplay = unchanged.replay.find(
      (item) => item.kind === "entry",
    );
    if (unchangedReplay?.kind !== "entry") throw new Error("expected entry");
    expect(
      (unchangedReplay.entry.message as { content: unknown }).content,
    ).toEqual([
      { type: "thinking", thinking: "signed" },
      { type: "text", text: "answer", textSignature: "answer-sig" },
    ]);

    const removed = planSurgery({
      entries,
      leafId: "assistant",
      operations: [
        {
          kind: "edit-unsigned",
          entryId: "assistant",
          blockIndex: 0,
          blockType: "thinking",
          text: "",
        },
      ],
    });
    const removedReplay = removed.replay.find((item) => item.kind === "entry");
    if (removedReplay?.kind !== "entry") throw new Error("expected entry");
    expect(
      (removedReplay.entry.message as { content: unknown }).content,
    ).toEqual([{ type: "text", text: "answer", textSignature: "answer-sig" }]);
  });

  it("rejects forged ordinary edits and unsafe detach targets", () => {
    const signed = assistant([
      { type: "text", text: "signed", textSignature: "sig" },
    ]);
    expect(() =>
      planSurgery({
        entries: [signed],
        leafId: "assistant",
        operations: [
          { kind: "edit-text", entryId: "assistant", blockIndex: 0, text: "x" },
        ],
      }),
    ).toThrow("read-only");
    expect(() =>
      planSurgery({
        entries: [assistant([{ type: "text", text: "plain" }])],
        leafId: "assistant",
        operations: [
          {
            kind: "edit-unsigned",
            entryId: "assistant",
            blockIndex: 0,
            blockType: "text",
            text: "x",
          },
        ],
      }),
    ).toThrow("not an eligible provider-signed");
    expect(() =>
      planSurgery({
        entries: [
          assistant([
            {
              type: "thinking",
              thinking: "redacted",
              redacted: true,
              thinkingSignature: "sig",
            },
            { type: "text", text: "answer" },
          ]),
        ],
        leafId: "assistant",
        operations: [
          {
            kind: "edit-unsigned",
            entryId: "assistant",
            blockIndex: 0,
            blockType: "thinking",
            text: "copy",
          },
        ],
      }),
    ).toThrow("not an eligible provider-signed");
  });

  it.each([
    {
      name: "provider-signed thinking",
      block: { type: "thinking", thinking: "signed", thinkingSignature: "sig" },
    },
    {
      name: "redacted thinking",
      block: { type: "thinking", thinking: "opaque", redacted: true },
    },
    {
      name: "signed answer text",
      block: { type: "text", text: "answer", textSignature: "sig" },
    },
    {
      name: "tool-associated thinking",
      block: {
        type: "toolCall",
        id: "call",
        name: "bash",
        arguments: {},
        thoughtSignature: "sig",
      },
    },
    {
      name: "unknown block",
      block: { type: "future_block", value: "opaque" },
    },
  ])("rejects $name reasoning edits", ({ block }) => {
    const entries = [
      assistant([
        block,
        { type: "thinking", thinking: "target" },
        { type: "text", text: "answer" },
      ]),
    ];
    let leafId = "assistant";
    if (block.type === "toolCall") {
      entries.push({
        type: "message",
        id: "result",
        parentId: "assistant",
        timestamp: "old",
        message: {
          role: "toolResult",
          toolCallId: "call",
          content: [{ type: "text", text: "result" }],
        },
      });
      leafId = "result";
    }
    expect(reasoningEligibility(entries[0]).eligible).toBe(false);
    expect(() =>
      planSurgery({
        entries,
        leafId,
        operations: [
          {
            kind: "edit-reasoning",
            entryId: "assistant",
            blockIndex: 1,
            thinking: "forged",
          },
        ],
      }),
    ).toThrow(/read-only/);
  });
});
