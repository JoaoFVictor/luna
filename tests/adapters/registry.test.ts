import { describe, expect, it } from "vitest";
import {
  AdapterJsonCommandError,
  executeJson
} from "../../src/adapters/registry.js";

describe("input adapter JSON command runner", () => {
  it("parses bounded UTF-8 JSON output", async () => {
    await expect(executeJson("/bin/sh", [
      "-c",
      "printf '%s' '{\"ok\":true}'"
    ])).resolves.toEqual({ ok: true });
  });

  it("terminates output that exceeds its explicit cap", async () => {
    await expect(executeJson("/bin/sh", [
      "-c",
      "while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"
    ], { maxOutputBytes: 32 })).rejects.toMatchObject({
      reason: "stdout_too_large"
    });
  });

  it.skipIf(process.platform === "win32")(
    "kills an aborted process group even when the command ignores SIGTERM",
    async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 50);
      const startedAt = Date.now();
      try {
        await expect(executeJson("/bin/sh", [
          "-c",
          "trap '' TERM; while :; do sleep 1; done"
        ], {
          signal: controller.signal,
          timeoutMs: 2_000
        })).rejects.toMatchObject({ reason: "aborted" });
      } finally {
        clearTimeout(abort);
      }
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    }
  );

  it("does not expose invalid command output through its error", async () => {
    const error = await executeJson("/bin/sh", [
      "-c",
      "printf '%s' private-not-json"
    ]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdapterJsonCommandError);
    expect(error).toMatchObject({ reason: "invalid_json" });
    expect(String((error as Error).message)).not.toContain("private-not-json");
  });
});
