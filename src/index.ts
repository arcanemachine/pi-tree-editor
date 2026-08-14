import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { installNativeHooks } from "./native/internal-imports.js";
import {
  clearSessionState,
  notifyHookFailureIfNeeded,
  setExtensionContext,
} from "./native/patch-state.js";

export default function piTreeEditor(pi: ExtensionAPI): void {
  void installNativeHooks();

  pi.on("session_start", (_event, ctx) => {
    setExtensionContext(ctx);
    void installNativeHooks().then(() => notifyHookFailureIfNeeded());
  });
  pi.on("session_shutdown", () => {
    clearSessionState();
  });
  pi.on("session_before_switch", () => {
    clearSessionState();
  });
}

export * from "./audit.js";
export * from "./surgery/active-path.js";
export * from "./surgery/logical-units.js";
export * from "./surgery/planner.js";
export * from "./surgery/replay.js";
export * from "./surgery/types.js";

// Keep a named reference useful to embedders without changing the Pi entrypoint.
export type TreeEditorContext = ExtensionContext;
