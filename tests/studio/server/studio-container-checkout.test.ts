import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSupportedStudioContainerCheckout } from "../../../src/studio/server/studio-container-checkout.js";

const roots: string[] = [];

async function checkoutRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-container-checkout-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("Studio container checkout preflight", () => {
  it("accepts physical Git metadata directories", async () => {
    const root = await checkoutRoot();
    await mkdir(path.join(root, ".git"));

    await expect(assertSupportedStudioContainerCheckout(root, {
      LUNA_STUDIO_CONTAINER_MODE: "1"
    })).resolves.toBeUndefined();
  });

  it("rejects linked-worktree gitfiles before starting services", async () => {
    const root = await checkoutRoot();
    await writeFile(
      path.join(root, ".git"),
      "gitdir: /host/main/.git/worktrees/linked\n",
      "utf8"
    );

    await expect(assertSupportedStudioContainerCheckout(root, {
      LUNA_STUDIO_CONTAINER_MODE: "1"
    })).rejects.toThrow("does not support linked Git worktrees");
  });

  it("does not impose Docker metadata rules on local execution", async () => {
    const root = await checkoutRoot();
    await writeFile(path.join(root, ".git"), "gitdir: elsewhere\n", "utf8");

    await expect(assertSupportedStudioContainerCheckout(root, {}))
      .resolves.toBeUndefined();
  });
});
