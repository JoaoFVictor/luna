import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { assertJsonValue, type JsonValue } from "../json/value.js";

type WritableFileHandle = {
  writeFile(value: string, encoding: BufferEncoding): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
};

export type AppendOnlyJsonlWriterDependencies = {
  mkdir?: (
    dirPath: string,
    options: { recursive: boolean; mode: number }
  ) => Promise<unknown>;
  open?: (
    filePath: string,
    flags: "a",
    mode: number
  ) => Promise<WritableFileHandle>;
};

export async function appendOnlyJsonlWriter({
  filePath,
  value,
  dependencies = {}
}: {
  filePath: string;
  value: unknown;
  dependencies?: AppendOnlyJsonlWriterDependencies;
}): Promise<void> {
  assertJsonValue(value);

  const mkdirDependency = dependencies.mkdir ?? mkdir;
  const openDependency = dependencies.open ?? open;

  await mkdirDependency(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await openDependency(filePath, "a", 0o600);
  let primaryError: unknown;

  try {
    await handle.writeFile(`${JSON.stringify(value as JsonValue)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (primaryError === undefined) {
        throw error;
      }

      if (primaryError instanceof Error) {
        (primaryError as Error & { closeError?: unknown }).closeError = error;
      }
    }
  }
}
