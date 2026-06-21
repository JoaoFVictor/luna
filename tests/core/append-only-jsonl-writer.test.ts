import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendOnlyJsonlWriter,
  type AppendOnlyJsonlWriterDependencies
} from "../../src/core/append-only-jsonl-writer.js";

describe("append-only JSONL writer", () => {
  it("appends newline-terminated JSONL with mkdir, write, sync, and close order", async () => {
    const operations: string[] = [];
    const dependencies: AppendOnlyJsonlWriterDependencies = {
      mkdir: async (dir, options) => {
        operations.push(`mkdir:${path.basename(dir)}:${options.mode.toString(8)}`);
      },
      open: async (_filePath, flags, mode) => {
        operations.push(`open:${flags}:${mode.toString(8)}`);
        return {
          writeFile: async (value, encoding) => {
            operations.push(`write:${encoding}:${value}`);
          },
          sync: async () => {
            operations.push("sync");
          },
          close: async () => {
            operations.push("close");
          }
        };
      }
    };

    await appendOnlyJsonlWriter({
      filePath: path.join("/tmp", "journal", "transactions.jsonl"),
      value: { runId: "run-a1", phase: "started" },
      dependencies
    });

    expect(operations).toEqual([
      "mkdir:journal:700",
      "open:a:600",
      'write:utf8:{"runId":"run-a1","phase":"started"}\n',
      "sync",
      "close"
    ]);
  });

  it("preserves write errors when close also fails", async () => {
    const writeError = new Error("write failed");
    const closeError = new Error("close failed");
    const dependencies: AppendOnlyJsonlWriterDependencies = {
      mkdir: async () => {},
      open: async () => ({
        writeFile: async () => {
          throw writeError;
        },
        sync: async () => {},
        close: async () => {
          throw closeError;
        }
      })
    };

    await expect(
      appendOnlyJsonlWriter({
        filePath: path.join("/tmp", "journal", "transactions.jsonl"),
        value: { runId: "run-a1", phase: "started" },
        dependencies
      })
    ).rejects.toBe(writeError);
    expect((writeError as Error & { closeError?: unknown }).closeError).toBe(
      closeError
    );
  });
});
