export type PositionedReader = {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): Promise<{ readonly bytesRead: number }>;
};

async function fillFromPosition(
  reader: PositionedReader,
  buffer: Buffer,
  targetBytes: number
): Promise<number> {
  let offset = 0;
  while (offset < targetBytes) {
    const result = await reader.read(
      buffer,
      offset,
      targetBytes - offset,
      offset
    );
    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > targetBytes - offset
    ) {
      return -1;
    }
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return offset;
}

export async function readCompleteBoundedFile(input: {
  readonly reader: PositionedReader;
  readonly expectedBytes: number;
  readonly maxBytes: number;
}): Promise<Buffer | undefined> {
  if (
    input.expectedBytes < 0 ||
    input.expectedBytes > input.maxBytes ||
    !Number.isSafeInteger(input.expectedBytes)
  ) {
    return undefined;
  }
  const buffer = Buffer.alloc(input.expectedBytes);
  const bytesRead = await fillFromPosition(
    input.reader,
    buffer,
    input.expectedBytes
  );
  return bytesRead === input.expectedBytes ? buffer : undefined;
}

export async function readBoundedJsonlFirstLine(input: {
  readonly reader: PositionedReader;
  readonly maxBytes: number;
}): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(input.maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await input.reader.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    );
    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > buffer.length - offset
    ) {
      return undefined;
    }
    if (result.bytesRead === 0) {
      return undefined;
    }
    const start = offset;
    offset += result.bytesRead;
    const relativeNewline = buffer.subarray(start, offset).indexOf(0x0a);
    if (relativeNewline >= 0) {
      const newline = start + relativeNewline;
      if (newline > input.maxBytes) {
        return undefined;
      }
      const end = newline > 0 && buffer[newline - 1] === 0x0d
        ? newline - 1
        : newline;
      return end === 0 ? undefined : buffer.subarray(0, end);
    }
  }
  return undefined;
}
