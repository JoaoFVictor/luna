import {
  writeFileAtomically,
  type AtomicWriteContent,
  type AtomicWriteHooks
} from "../filesystem/atomic-write.js";

export type { AtomicWriteContent, AtomicWriteHooks };

export async function atomicWriteFile(
  targetPath: string,
  content: AtomicWriteContent,
  mode: number,
  hooks: AtomicWriteHooks = {}
): Promise<void> {
  await writeFileAtomically(targetPath, content, {
    mode,
    errorCode: "artifact_atomic_write_failed",
    errorLabel: "Atomic artifact write",
    hooks
  });
}
