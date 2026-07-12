import { describe, expect, it } from "vitest";
import {
  readBoundedJsonlFirstLine,
  readCompleteBoundedFile,
  type PositionedReader
} from "../../../src/studio/adapters/filesystem/bounded-positioned-read.js";

function shortReader(content: Buffer, chunkSize: number): PositionedReader {
  return {
    async read(buffer, offset, length, position) {
      const bytesRead = Math.min(
        chunkSize,
        length,
        Math.max(0, content.length - position)
      );
      content.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    }
  };
}

describe("bounded positioned reads", () => {
  it("loops across short reads instead of accepting a JSON prefix", async () => {
    const content = Buffer.from('{"run_id":"run-1"} trailing-bytes', "utf8");
    const read = await readCompleteBoundedFile({
      reader: shortReader(content, 3),
      expectedBytes: content.length,
      maxBytes: 1_024
    });

    expect(read).toEqual(content);
    expect(() => JSON.parse(read?.toString("utf8") ?? "")).toThrow();
  });

  it("finds a bounded JSONL newline across short reads", async () => {
    const first = Buffer.from('{"type":"span.started"}', "utf8");
    const content = Buffer.concat([first, Buffer.from("\nsecond-line\n")]);

    await expect(readBoundedJsonlFirstLine({
      reader: shortReader(content, 2),
      maxBytes: 128
    })).resolves.toEqual(first);
  });

  it("rejects early EOF and a line without a bounded newline", async () => {
    const truncated = Buffer.from('{"run_id":"run-1"}', "utf8");
    await expect(readCompleteBoundedFile({
      reader: shortReader(truncated, 4),
      expectedBytes: truncated.length + 1,
      maxBytes: 1_024
    })).resolves.toBeUndefined();
    await expect(readBoundedJsonlFirstLine({
      reader: shortReader(Buffer.from("x".repeat(65)), 3),
      maxBytes: 64
    })).resolves.toBeUndefined();
  });
});
