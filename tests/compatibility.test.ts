import { afterEach, describe, expect, it } from "vitest";
import {
  installNativeHooks,
  installNativeHooksForTest,
  installNativeHooksWithModulesForTest,
} from "../src/native/internal-imports.js";
import {
  clearSessionState,
  getHookStatus,
  setExtensionContext,
  setHookStatus,
} from "../src/native/patch-state.js";

type FakeModules = {
  selectorModule: Record<string, unknown>;
  interactiveModule: Record<string, unknown>;
  selectorCalls: string[];
  interactiveCalls: number[];
  displayList: {
    getEntryDisplayText(node: unknown, isSelected: boolean): string;
  };
};

function fakeModules(): FakeModules {
  const selectorCalls: string[] = [];
  const interactiveCalls: number[] = [];
  const displayList = {
    getEntryDisplayText(node: unknown, isSelected: boolean): string {
      const entry = (node as { entry?: { text?: string } }).entry;
      return `${isSelected ? ">" : "-"}${entry?.text ?? "native row"}`;
    },
  };
  class TreeHelp {
    render(width: number): string[] {
      return [`native help ${width}`, "native footer"];
    }
  }
  class TreeSelectorComponent {
    children = [new TreeHelp()];

    handleInput(data: string): void {
      selectorCalls.push(data);
    }
    getTreeList(): object {
      return displayList;
    }
    render(width: number): string[] {
      return [
        "native tree",
        ...this.children.flatMap((child) => child.render(width)),
      ];
    }
  }
  class InteractiveMode {
    showTreeSelector(..._args: unknown[]): void {
      interactiveCalls.push(1);
    }
  }
  return {
    selectorModule: { TreeSelectorComponent },
    interactiveModule: { InteractiveMode },
    selectorCalls,
    interactiveCalls,
    displayList,
  };
}

function captureWarnings(): string[] {
  const warnings: string[] = [];
  setExtensionContext({
    ui: {
      notify: (message: string, level: string) => {
        if (level === "warning") warnings.push(message);
      },
    },
  } as never);
  return warnings;
}

afterEach(() => {
  clearSessionState();
  setHookStatus({ enabled: true });
});

describe("native compatibility", () => {
  it("installs against the current Pi internals or reports a guarded failure", async () => {
    const installed = await installNativeHooks();
    const status = getHookStatus();
    expect(status.enabled).toBe(installed);
    if (!installed) expect(status.reason).toBeTruthy();
  });

  it("keeps core hooks when the optional theme module is unavailable", async () => {
    const modules = fakeModules();
    const installed = await installNativeHooksForTest(async () => ({
      selectorModule: modules.selectorModule,
      interactiveModule: modules.interactiveModule,
    }));

    expect(installed).toBe(true);
    new (modules.selectorModule.TreeSelectorComponent as any)().handleInput(
      "native",
    );
    expect(modules.selectorCalls).toEqual(["native"]);
  });

  it("keeps native behavior when selector module import fails", async () => {
    const modules = fakeModules();
    const originalSelectorHandle = (
      modules.selectorModule.TreeSelectorComponent as any
    ).prototype.handleInput;
    const originalInteractiveShow = (
      modules.interactiveModule.InteractiveMode as any
    ).prototype.showTreeSelector;
    const warnings: string[] = [];
    const installed = await installNativeHooksForTest(async () => {
      throw new Error("tree selector import failed");
    });

    expect(installed).toBe(false);
    expect(
      (modules.selectorModule.TreeSelectorComponent as any).prototype
        .handleInput,
    ).toBe(originalSelectorHandle);
    expect(
      (modules.interactiveModule.InteractiveMode as any).prototype
        .showTreeSelector,
    ).toBe(originalInteractiveShow);
    expect(warnings).toHaveLength(0);
    setExtensionContext({
      ui: {
        notify: (message: string, level: string) => {
          if (level === "warning") warnings.push(message);
        },
      },
    } as never);
    new (modules.selectorModule.TreeSelectorComponent as any)().handleInput(
      "native",
    );
    new (modules.interactiveModule.InteractiveMode as any)().showTreeSelector();
    expect(modules.selectorCalls).toEqual(["native"]);
    expect(modules.interactiveCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("native /tree editing unavailable");
    expect(warnings[0]).not.toContain("/tree-editor status");
  });

  it("keeps native behavior when selector shape probing fails", () => {
    const modules = fakeModules();
    const originalInteractiveShow = (
      modules.interactiveModule.InteractiveMode as any
    ).prototype.showTreeSelector;
    const warnings = captureWarnings();
    class IncompatibleSelector {
      handleInput(data: string): void {
        modules.selectorCalls.push(data);
      }
    }

    const installed = installNativeHooksWithModulesForTest(
      { TreeSelectorComponent: IncompatibleSelector },
      modules.interactiveModule,
    );

    expect(installed).toBe(false);
    expect(
      (modules.interactiveModule.InteractiveMode as any).prototype
        .showTreeSelector,
    ).toBe(originalInteractiveShow);
    new IncompatibleSelector().handleInput("native");
    new (modules.interactiveModule.InteractiveMode as any)().showTreeSelector();
    expect(modules.selectorCalls).toEqual(["native"]);
    expect(modules.interactiveCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("required native methods");
    expect(warnings[0]).not.toContain("/tree-editor status");
  });

  it("rolls back selector patch when interactive patch installation fails", () => {
    const modules = fakeModules();
    const originalSelectorHandle = (
      modules.selectorModule.TreeSelectorComponent as any
    ).prototype.handleInput;
    const originalInteractiveShow = (
      modules.interactiveModule.InteractiveMode as any
    ).prototype.showTreeSelector;
    const warnings = captureWarnings();
    const interactivePrototype = (
      modules.interactiveModule.InteractiveMode as any
    ).prototype;
    Object.defineProperty(interactivePrototype, "showTreeSelector", {
      configurable: false,
      writable: false,
      value: interactivePrototype.showTreeSelector,
    });

    const installed = installNativeHooksWithModulesForTest(
      modules.selectorModule,
      modules.interactiveModule,
    );

    expect(installed).toBe(false);
    expect(
      (modules.selectorModule.TreeSelectorComponent as any).prototype
        .handleInput,
    ).toBe(originalSelectorHandle);
    expect(
      (modules.interactiveModule.InteractiveMode as any).prototype
        .showTreeSelector,
    ).toBe(originalInteractiveShow);
    new (modules.selectorModule.TreeSelectorComponent as any)().handleInput(
      "native",
    );
    new (modules.interactiveModule.InteractiveMode as any)().showTreeSelector();
    expect(modules.selectorCalls).toEqual(["native"]);
    expect(modules.interactiveCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Native tree hooks unavailable");
  });

  it("bypasses selector augmentation after a runtime capability failure", () => {
    const modules = fakeModules();
    const originalDisplay = modules.displayList.getEntryDisplayText;
    const nativeNode = { entry: { text: "native row" } };
    const nativeRow = originalDisplay(nativeNode, false);
    const warnings = captureWarnings();
    const installed = installNativeHooksWithModulesForTest(
      modules.selectorModule,
      modules.interactiveModule,
      { theme: { fg: (_color: string, text: string) => text } },
    );
    expect(installed).toBe(true);

    const selector = new (modules.selectorModule
      .TreeSelectorComponent as any)();
    const nativeHelp = selector.children[0].render(30);
    const enabledLines = selector.render(30);
    expect(
      enabledLines.some((line: string) => line.includes("Tree editor")),
    ).toBe(true);
    expect(modules.displayList.getEntryDisplayText).not.toBe(originalDisplay);

    const mode = new (modules.interactiveModule.InteractiveMode as any)();
    mode.showTreeSelector.call({});
    mode.showTreeSelector.call({});
    selector.handleInput("native");
    const disabledLines = selector.render(30);
    const disabledRow = modules.displayList.getEntryDisplayText(
      nativeNode,
      false,
    );

    expect(disabledLines).toEqual(["native tree", ...nativeHelp]);
    expect(disabledRow).toBe(nativeRow);
    expect(
      disabledLines.some((line: string) => line.includes("Tree editor")),
    ).toBe(false);
    expect(modules.interactiveCalls).toHaveLength(2);
    expect(modules.selectorCalls).toEqual(["native"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("native /tree editing unavailable");
  });
});
