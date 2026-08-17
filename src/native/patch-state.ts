import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookStatus } from "./compatibility.js";

export type SelectorState = {
  editMode: boolean;
  reasoningPreviewsVisible: boolean;
  operations: import("../surgery/types.js").SurgeryOperation[];
  snapshot?: {
    sessionId?: string;
    leafId: string | null;
    entries: import("../surgery/types.js").SessionEntryLike[];
  };
  busy: boolean;
  confirmingExit: boolean;
  flow?:
    | "save-review"
    | "exit-confirm"
    | "block-choice"
    | "role-choice"
    | "signed-override";
  flowComponent?: {
    handleInput(data: string): void;
    finish(): void;
    cancel(): void;
  };
  inlineInput?: {
    input: { handleInput(data: string): void };
    finish(): void;
    cancel(): void;
    submit(): void;
  };
};

const selectorStates = new WeakMap<object, SelectorState>();
let context: ExtensionContext | undefined;
let activeMode: Record<string, unknown> | undefined;
let status: HookStatus = { enabled: false };
let notifiedFailureReason: string | undefined;

export function selectorState(selector: object): SelectorState {
  let state = selectorStates.get(selector);
  if (!state) {
    state = {
      editMode: false,
      reasoningPreviewsVisible: false,
      operations: [],
      busy: false,
      confirmingExit: false,
    };
    selectorStates.set(selector, state);
  }
  return state;
}

export function setExtensionContext(next: ExtensionContext | undefined): void {
  context = next;
  notifyHookFailure();
}

export function getExtensionContext(): ExtensionContext | undefined {
  return context;
}

export function setActiveMode(mode: Record<string, unknown> | undefined): void {
  activeMode = mode;
}

export function getActiveMode(): Record<string, unknown> | undefined {
  return activeMode;
}

export function setHookStatus(next: HookStatus): void {
  status = next;
  if (next.enabled) notifiedFailureReason = undefined;
}

export function reportHookFailure(reason: string): void {
  status = { enabled: false, reason };
  notifyHookFailure();
}

function notifyHookFailure(): void {
  if (!context || !status.reason || status.enabled) return;
  if (notifiedFailureReason === status.reason) return;
  notifiedFailureReason = status.reason;
  try {
    context.ui.notify(
      `pi-tree-editor: native /tree editing unavailable — ${status.reason}. Native /tree remains available unchanged.`,
      "warning",
    );
  } catch {
    // Notification must never interfere with native /tree behavior.
  }
}

export function notifyHookFailureIfNeeded(): void {
  notifyHookFailure();
}

export function getHookStatus(): HookStatus {
  return status;
}

export function clearSessionState(): void {
  context = undefined;
  activeMode = undefined;
  notifiedFailureReason = undefined;
}
