export type HookStatus = {
  enabled: boolean;
  reason?: string;
  installedAt?: string;
};

export type NativeModules = {
  treeSelector: Record<string, unknown>;
  interactiveMode: Record<string, unknown>;
};

export function probeSelectorModule(
  module: Record<string, unknown>,
): string | undefined {
  if (typeof module.TreeSelectorComponent !== "function") {
    return "TreeSelectorComponent is not exported by the installed Pi";
  }
  const prototype = (
    module.TreeSelectorComponent as { prototype?: Record<string, unknown> }
  ).prototype;
  if (
    !prototype ||
    typeof prototype.handleInput !== "function" ||
    typeof prototype.getTreeList !== "function"
  ) {
    return "TreeSelectorComponent lacks the required native methods";
  }
  return undefined;
}

export function probeInteractiveModule(
  module: Record<string, unknown>,
): string | undefined {
  const candidate = module.InteractiveMode as
    | { prototype?: Record<string, unknown> }
    | undefined;
  if (
    !candidate?.prototype ||
    typeof candidate.prototype.showTreeSelector !== "function"
  ) {
    return "InteractiveMode.showTreeSelector is unavailable";
  }
  return undefined;
}

export function probeRuntimeMode(mode: unknown): string | undefined {
  if (!mode || typeof mode !== "object")
    return "No active InteractiveMode instance was observed";
  const value = mode as Record<string, unknown>;
  if (!value.sessionManager || typeof value.sessionManager !== "object")
    return "InteractiveMode has no session manager";
  if (!value.session || typeof value.session !== "object")
    return "InteractiveMode has no AgentSession";
  const manager = value.sessionManager as Record<string, unknown>;
  const required = [
    "getEntries",
    "getLeafId",
    "branch",
    "resetLeaf",
    "appendMessage",
    "appendCustomEntry",
  ];
  const missing = required.filter(
    (name) => typeof manager[name] !== "function",
  );
  return missing.length > 0
    ? `SessionManager is missing ${missing.join(", ")}`
    : undefined;
}
