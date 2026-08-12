import {
  probeInteractiveModule,
  probeSelectorModule,
} from "./compatibility.js";
import { patchInteractiveMode } from "./patch-interactive-mode.js";
import { patchTreeSelector } from "./patch-tree-selector.js";
import { setHookStatus } from "./patch-state.js";

let installing: Promise<boolean> | undefined;

export function installNativeHooks(): Promise<boolean> {
  if (!installing) installing = install();
  return installing;
}

async function install(): Promise<boolean> {
  try {
    const resolved = await import.meta
      .resolve("@earendil-works/pi-coding-agent");
    const selectorUrl = new URL(
      "./modes/interactive/components/tree-selector.js",
      resolved,
    ).href;
    const interactiveUrl = new URL(
      "./modes/interactive/interactive-mode.js",
      resolved,
    ).href;
    const selectorModule = (await import(selectorUrl)) as Record<
      string,
      unknown
    >;
    const interactiveModule = (await import(interactiveUrl)) as Record<
      string,
      unknown
    >;
    const selectorReason = probeSelectorModule(selectorModule);
    if (selectorReason) {
      setHookStatus({ enabled: false, reason: selectorReason });
      return false;
    }
    const interactiveReason = probeInteractiveModule(interactiveModule);
    if (interactiveReason) {
      setHookStatus({ enabled: false, reason: interactiveReason });
      return false;
    }
    const selectorPatched = patchTreeSelector(selectorModule);
    const interactivePatched = patchInteractiveMode(interactiveModule);
    if (!selectorPatched || !interactivePatched) {
      setHookStatus({
        enabled: false,
        reason: "Native tree hooks could not be installed",
      });
      return false;
    }
    return true;
  } catch (error) {
    setHookStatus({
      enabled: false,
      reason: `Native tree hooks unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
}
