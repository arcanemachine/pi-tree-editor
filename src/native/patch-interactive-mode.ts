import { probeInteractiveModule, probeRuntimeMode } from "./compatibility.js";
import { setActiveMode, setHookStatus } from "./patch-state.js";

const PATCHED = "__piTreeEditorInteractivePatched";

export function patchInteractiveMode(module: Record<string, unknown>): boolean {
  const constructor = module.InteractiveMode as
    { prototype?: Record<string, any> } | undefined;
  const prototype = constructor?.prototype;
  const reason = probeInteractiveModule(module);
  if (reason || !prototype) {
    setHookStatus({
      enabled: false,
      reason: reason ?? "InteractiveMode prototype is unavailable",
    });
    return false;
  }
  if (prototype[PATCHED]) return true;
  const original = prototype.showTreeSelector;
  if (typeof original !== "function") {
    setHookStatus({
      enabled: false,
      reason: "InteractiveMode.showTreeSelector is unavailable",
    });
    return false;
  }
  prototype.showTreeSelector = function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ): unknown {
    const mode = this as Record<string, unknown>;
    setActiveMode(mode);
    const runtimeReason = probeRuntimeMode(mode);
    if (runtimeReason) setHookStatus({ enabled: false, reason: runtimeReason });
    return original.apply(this, args);
  };
  prototype[PATCHED] = true;
  return true;
}
