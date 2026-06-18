import { mkdtemp, readFile, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertSafeSegment,
  isInsideRoot,
  safeJoin,
  slugify
} from "../../src/core/path-security.js";

async function tempRoot(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

describe("path security", () => {
  it("slugifies provider text for path-safe names", () => {
    expect(slugify("Org/Repo PR#123")).toBe("org-repo-pr-123");
  });

  it("rejects traversal outside the root", async () => {
    const root = await tempRoot("luna-safe-root-");

    await expect(safeJoin(root, ["..", "outside"])).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects a symlink inside root that resolves outside root", async () => {
    const root = await tempRoot("luna-safe-root-");
    const outside = await tempRoot("luna-outside-root-");
    const link = join(root, "escape");

    try {
      await symlink(outside, link, "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        return;
      }

      throw error;
    }

    await expect(safeJoin(root, ["escape"])).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("does not accept prefix siblings as inside the root", () => {
    const rootReal = resolve("/tmp/root");
    const siblingReal = resolve("/tmp/root2");

    expect(isInsideRoot(rootReal, siblingReal)).toBe(false);
  });

  it("accepts paths inside the root", () => {
    const rootReal = resolve("/tmp/root");
    const childReal = resolve("/tmp/root/child/file.txt");

    expect(isInsideRoot(rootReal, childReal)).toBe(true);
  });

  it("does not use startsWith for containment checks", async () => {
    const source = await readFile("src/core/path-security.ts", "utf8");

    expect(source).not.toContain("startsWith");
  });

  it("rejects absolute provider-derived segments", () => {
    expect(() => assertSafeSegment("/tmp/provider")).toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });
});
