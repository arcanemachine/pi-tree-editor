import {
  probeInteractiveModule,
  probeSelectorModule,
} from "./compatibility.js";
import { patchInteractiveMode } from "./patch-interactive-mode.js";
import { patchTreeSelector } from "./patch-tree-selector.js";
import { reportHookFailure } from "./patch-state.js";

type NativeModule = Record<string, unknown>;
type NativeModuleLoader = () => Promise<{
  selectorModule: NativeModule;
  interactiveModule: NativeModule;
  themeModule?: NativeModule;
}>;

let installing: Promise<boolean> | undefined;

export function installNativeHooks(): Promise<boolean> {
  if (!installing) installing = install();
  return installing;
}

async function install(): Promise<boolean> {
  return installWithLoader(async () => {
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
    let themeModule: NativeModule | undefined;
    try {
      const themeUrl = new URL("./modes/interactive/theme/theme.js", resolved)
        .href;
      themeModule = (await import(themeUrl)) as NativeModule;
    } catch {
      themeModule = undefined;
    }
    return {
      selectorModule: (await import(selectorUrl)) as NativeModule,
      interactiveModule: (await import(interactiveUrl)) as NativeModule,
      themeModule,
    };
  });
}

async function installWithLoader(loader: NativeModuleLoader): Promise<boolean> {
  try {
    const modules = await loader();
    return installWithModules(
      modules.selectorModule,
      modules.interactiveModule,
      modules.themeModule,
    );
  } catch (error) {
    reportHookFailure(
      `Native tree hooks unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function installWithModules(
  selectorModule: NativeModule,
  interactiveModule: NativeModule,
  themeModule?: NativeModule,
): boolean {
  const snapshots = snapshotPatchTargets(selectorModule, interactiveModule);
  let installed = false;
  try {
    const selectorReason = probeSelectorModule(selectorModule);
    if (selectorReason) {
      reportHookFailure(selectorReason);
      return false;
    }
    const interactiveReason = probeInteractiveModule(interactiveModule);
    if (interactiveReason) {
      reportHookFailure(interactiveReason);
      return false;
    }
    if (!patchTreeSelector(selectorModule, themeModule?.theme)) return false;
    if (!patchInteractiveMode(interactiveModule)) return false;
    installed = true;
    return true;
  } catch (error) {
    reportHookFailure(
      `Native tree hooks unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  } finally {
    // Installation is transactional: a failed second patch must not leave the
    // native selector carrying the first patch.
    if (!installed) restorePatchTargets(snapshots);
  }
}

type PrototypeSnapshot = {
  target: object;
  descriptors: Map<PropertyKey, PropertyDescriptor>;
};

function snapshotPatchTargets(
  selectorModule: NativeModule,
  interactiveModule: NativeModule,
): PrototypeSnapshot[] {
  const targets: object[] = [];
  const selectorPrototype = getPrototype(selectorModule.TreeSelectorComponent);
  const interactivePrototype = getPrototype(interactiveModule.InteractiveMode);
  if (selectorPrototype) targets.push(selectorPrototype);
  if (interactivePrototype && interactivePrototype !== selectorPrototype) {
    targets.push(interactivePrototype);
  }
  return targets.map((target) => ({
    target,
    descriptors: new Map(
      Reflect.ownKeys(target).flatMap((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        return descriptor ? [[key, descriptor] as const] : [];
      }),
    ),
  }));
}

function getPrototype(candidate: unknown): object | undefined {
  if (typeof candidate !== "function") return undefined;
  const prototype = (candidate as { prototype?: unknown }).prototype;
  return prototype && typeof prototype === "object" ? prototype : undefined;
}

function restorePatchTargets(snapshots: PrototypeSnapshot[]): void {
  for (const { target, descriptors } of snapshots) {
    for (const key of Reflect.ownKeys(target)) {
      if (!descriptors.has(key)) Reflect.deleteProperty(target, key);
    }
    for (const [key, descriptor] of descriptors) {
      Reflect.defineProperty(target, key, descriptor);
    }
  }
}

// Kept separate from the production loader so compatibility tests can exercise
// import, probe, and patch failures without mutating the installed Pi modules.
export async function installNativeHooksForTest(
  loader: NativeModuleLoader,
): Promise<boolean> {
  return installWithLoader(loader);
}

export function installNativeHooksWithModulesForTest(
  selectorModule: NativeModule,
  interactiveModule: NativeModule,
  themeModule?: NativeModule,
): boolean {
  return installWithModules(selectorModule, interactiveModule, themeModule);
}
