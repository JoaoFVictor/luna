import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertSafeSegment,
  isInsideRoot,
  safeJoin,
  slugify
} from "../../src/core/security/path.js";

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

  it("does not create the root before rejecting unsafe segments", async () => {
    const parent = await tempRoot("luna-safe-parent-");
    const root = join(parent, "not-created");

    await expect(safeJoin(root, [".."])).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("rejects a missing child below a directory symlink outside root", async () => {
    const root = await tempRoot("luna-safe-root-");
    const outside = await tempRoot("luna-outside-root-");
    await symlink(outside, join(root, "escape"), "dir");

    await expect(
      safeJoin(root, ["escape", "missing.txt"])
    ).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("rejects a dangling symlink inside root", async () => {
    const root = await tempRoot("luna-safe-root-");
    const outside = await tempRoot("luna-outside-root-");
    await symlink(join(outside, "missing.txt"), join(root, "escape"));

    await expect(safeJoin(root, ["escape"])).rejects.toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });

  it("returns the physical target instead of retaining a swappable symlink alias", async () => {
    const root = await tempRoot("luna-safe-root-");
    const outside = await tempRoot("luna-outside-root-");
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    await mkdir(physical);
    await symlink(physical, alias, "dir");

    const resolved = await safeJoin(root, ["alias", "file.txt"]);
    expect(resolved).toBe(join(physical, "file.txt"));

    await rm(alias);
    await symlink(outside, alias, "dir");
    await writeFile(resolved, "confined", "utf8");

    await expect(access(join(physical, "file.txt"))).resolves.toBeUndefined();
    await expect(access(join(outside, "file.txt"))).rejects.toMatchObject({
      code: "ENOENT"
    });
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

  it("rejects absolute provider-derived segments", () => {
    expect(() => assertSafeSegment("/tmp/provider")).toThrow(
      expect.objectContaining({ code: "path_security_violation" })
    );
  });
});
