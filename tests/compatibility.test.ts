import { describe, expect, it } from "vitest";
import { installNativeHooks } from "../src/native/internal-imports.js";
import { getHookStatus } from "../src/native/patch-state.js";

describe("native compatibility", () => {
  it("installs against the current Pi internals or reports a guarded failure", async () => {
    const installed = await installNativeHooks();
    const status = getHookStatus();
    expect(status.enabled).toBe(installed);
    if (!installed) expect(status.reason).toBeTruthy();
  });
});
