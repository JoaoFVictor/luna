import { describe, expect, it } from "vitest";
import { createAgent } from "@flue/runtime";
import { access } from "node:fs/promises";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("flue import", () => {
  it("imports createAgent from @flue/runtime", () => {
    expect(typeof createAgent).toBe("function");
  });

  it("keeps Flue runtime adapter modules under agent-runtime/flue", async () => {
    await expect(exists("src/core/agent-runtime/flue/runner.ts")).resolves.toBe(true);
    await expect(exists("src/core/agent-runtime/flue/capabilities.ts")).resolves.toBe(true);
    await expect(exists("src/core/agent-runtime/flue/workflow-factory.ts")).resolves.toBe(true);
    await expect(exists("src/core/flue-agent-runner.ts")).resolves.toBe(false);
    await expect(exists("src/core/flue-agent-capabilities.ts")).resolves.toBe(false);
    await expect(exists("src/core/pi-auth.ts")).resolves.toBe(false);
  });
});
