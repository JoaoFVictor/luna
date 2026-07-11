import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../../src/core/artifacts/atomic-write.js";
import { writeFileAtomically } from "../../src/core/filesystem/atomic-write.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-atomic-write-"));
  roots.push(root);
  return root;
}

describe("generic atomic file writes", () => {
  it("syncs and replaces a file without leaving temporary files", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "draft.json");
    const events: string[] = [];

    await writeFileAtomically(target, "draft\n", {
      mode: 0o600,
      errorCode: "studio_atomic_write_failed",
      errorLabel: "Studio atomic write",
      hooks: {
        onTempFileCreated: () => events.push("temporary"),
        onFileSynced: () => events.push("file-synced"),
        onDirectorySynced: () => events.push("directory-synced")
      }
    });

    expect(await readFile(target, "utf8")).toBe("draft\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["draft.json"]);
    expect(events).toEqual(["temporary", "file-synced", "directory-synced"]);
  });

  it("keeps the artifact compatibility wrapper and error code", async () => {
    const root = await temporaryRoot();
    const missingParentTarget = path.join(root, "missing", "artifact.json");

    await expect(
      atomicWriteFile(missingParentTarget, "artifact", 0o600)
    ).rejects.toMatchObject({ code: "artifact_atomic_write_failed" });
  });

  it("treats hooks as audit-only even when they throw or reject", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "draft.json");

    await expect(
      writeFileAtomically(target, "durable\n", {
        mode: 0o600,
        errorCode: "studio_atomic_write_failed",
        errorLabel: "Studio atomic write",
        hooks: {
          onTempFileCreated: () => {
            throw new Error("audit failed");
          },
          onFileSynced: async () => {
            throw new Error("async audit failed");
          },
          onDirectorySynced: () => {
            throw new Error("audit failed");
          }
        }
      })
    ).resolves.toBeUndefined();
    await expect(readFile(target, "utf8")).resolves.toBe("durable\n");
  });

  for (const stage of [
    "after_temp_file_created",
    "after_file_synced"
  ] as const) {
    it(`reports ${stage} as not committed and preserves the target`, async () => {
      const root = await temporaryRoot();
      const target = path.join(root, "draft.json");
      await writeFile(target, "old\n", { mode: 0o640 });

      await expect(
        writeFileAtomically(target, "new\n", {
          mode: 0o600,
          errorCode: "studio_atomic_write_failed",
          errorLabel: "Studio atomic write",
          faultInjector: (currentStage) => {
            if (currentStage === stage) {
              throw new Error(`injected ${stage}`);
            }
          }
        })
      ).rejects.toMatchObject({
        code: "studio_atomic_write_failed",
        commitState: "not_committed"
      });
      await expect(readFile(target, "utf8")).resolves.toBe("old\n");
      await expect(readdir(root)).resolves.toEqual(["draft.json"]);
    });
  }

  for (const stage of ["after_rename", "after_directory_synced"] as const) {
    it(`reports ${stage} as commit-ambiguous after installing exact mode`, async () => {
      const root = await temporaryRoot();
      const target = path.join(root, "draft.json");
      let installedMode: number | undefined;

      await expect(
        writeFileAtomically(target, "new\n", {
          mode: 0o600,
          errorCode: "studio_atomic_write_failed",
          commitAmbiguousErrorCode: "studio_atomic_write_commit_ambiguous",
          errorLabel: "Studio atomic write",
          faultInjector: async (currentStage) => {
            if (currentStage === stage) {
              installedMode = (await stat(target)).mode & 0o777;
              throw new Error(`injected ${stage}`);
            }
          }
        })
      ).rejects.toMatchObject({
        code: "studio_atomic_write_commit_ambiguous",
        commitState: "commit_ambiguous"
      });
      expect(installedMode).toBe(0o600);
      await expect(readFile(target, "utf8")).resolves.toBe("new\n");
      await expect(readdir(root)).resolves.toEqual(["draft.json"]);
    });
  }
});
