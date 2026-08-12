import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getHookStatus } from "./native/patch-state.js";

export function registerTreeEditorCommand(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("tree-editor", {
    description: "Show pi-tree-editor hook status",
    getArgumentCompletions: () => [{ value: "status", label: "status" }],
    handler: async (args, ctx) => {
      await handleStatus(args, ctx);
    },
  });
}

async function handleStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const action = args.trim() || "status";
  if (action !== "status") {
    ctx.ui.notify("Usage: /tree-editor status", "warning");
    return;
  }
  const status = getHookStatus();
  if (status.enabled) {
    ctx.ui.notify("pi-tree-editor: active (native /tree hooks installed)", "info");
  } else if (status.reason) {
    ctx.ui.notify(`pi-tree-editor: unavailable — ${status.reason}`, "warning");
  } else {
    ctx.ui.notify("pi-tree-editor: inactive (native hooks not installed yet)", "info");
  }
}
