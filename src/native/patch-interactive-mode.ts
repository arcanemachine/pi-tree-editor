import { probeInteractiveModule, probeRuntimeMode } from "./compatibility.js";
import { reportHookFailure, setActiveMode } from "./patch-state.js";

const PATCHED = "__piTreeEditorInteractivePatched";

export function patchInteractiveMode(module: Record<string, unknown>): boolean {
  const constructor = module.InteractiveMode as
    | { prototype?: Record<string, any> }
    | undefined;
  const prototype = constructor?.prototype;
  const reason = probeInteractiveModule(module);
  if (reason || !prototype) {
    reportHookFailure(reason ?? "InteractiveMode prototype is unavailable");
    return false;
  }
  if (prototype[PATCHED]) return true;
  const original = prototype.showTreeSelector;
  if (typeof original !== "function") {
    reportHookFailure("InteractiveMode.showTreeSelector is unavailable");
    return false;
  }
  prototype.showTreeSelector = function (
    this: Record<string, unknown>,
    ...args: unknown[]
  ): unknown {
    const mode = this as Record<string, unknown>;
    setActiveMode(mode);
    const runtimeReason = probeRuntimeMode(mode);
    if (runtimeReason) reportHookFailure(runtimeReason);
    return original.apply(this, args);
  };
  prototype[PATCHED] = true;
  return true;
}
