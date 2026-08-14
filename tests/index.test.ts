import { describe, expect, it } from "vitest";
import piTreeEditor from "../src/index.js";

describe("extension entrypoint", () => {
  it("does not register a status command", () => {
    const commands: string[] = [];
    piTreeEditor({
      registerCommand: (name: string) => commands.push(name),
      on: () => undefined,
    } as never);
    expect(commands).not.toContain("tree-editor");
  });
});
