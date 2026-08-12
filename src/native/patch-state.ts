import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookStatus } from "./compatibility.js";

export type SelectorState = {
  editMode: boolean;
  operations: import("../surgery/types.js").SurgeryOperation[];
  snapshot?: {
    sessionId?: string;
    leafId: string | null;
    entries: import("../surgery/types.js").SessionEntryLike[];
  };
  busy: boolean;
  confirmingExit: boolean;
  flow?: "save-review" | "exit-confirm" | "block-choice";
  flowComponent?: {
    handleInput(data: string): void;
    finish(): void;
    cancel(): void;
  };
  inlineInput?: {
    input: { handleInput(data: string): void; setValue(value: string): void };
    finish(): void;
    cancel(): void;
  };
};

const selectorStates = new WeakMap<object, SelectorState>();
let context: ExtensionContext | undefined;
let activeMode: Record<string, unknown> | undefined;
let status: HookStatus = { enabled: false };

export function selectorState(selector: object): SelectorState {
  let state = selectorStates.get(selector);
  if (!state) {
    state = {
      editMode: false,
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
}

export function getHookStatus(): HookStatus {
  return status;
}

export function clearSessionState(): void {
  context = undefined;
  activeMode = undefined;
}
