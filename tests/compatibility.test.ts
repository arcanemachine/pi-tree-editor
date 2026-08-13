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
};

function fakeModules(): FakeModules {
  const selectorCalls: string[] = [];
  const interactiveCalls: number[] = [];
  class TreeSelectorComponent {
    handleInput(data: string): void {
      selectorCalls.push(data);
    }
    getTreeList(): object {
      return {};
    }
    render(): string[] {
      return [];
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

  it("keeps native behavior when selector module import fails", async () => {
    const modules = fakeModules();
    const warnings: string[] = [];
    const installed = await installNativeHooksForTest(async () => {
      throw new Error("tree selector import failed");
    });

    expect(installed).toBe(false);
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
  });

  it("keeps native behavior when selector shape probing fails", () => {
    const modules = fakeModules();
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
    new IncompatibleSelector().handleInput("native");
    new (modules.interactiveModule.InteractiveMode as any)().showTreeSelector();
    expect(modules.selectorCalls).toEqual(["native"]);
    expect(modules.interactiveCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("required native methods");
  });

  it("rolls back selector patch when interactive patch installation fails", () => {
    const modules = fakeModules();
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
    new (modules.selectorModule.TreeSelectorComponent as any)().handleInput(
      "native",
    );
    new (modules.interactiveModule.InteractiveMode as any)().showTreeSelector();
    expect(modules.selectorCalls).toEqual(["native"]);
    expect(modules.interactiveCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Native tree hooks unavailable");
  });
});
