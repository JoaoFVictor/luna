import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { validatePngStructure } from "../../../src/capabilities/social-post/png-validation.js";

const validPng = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
));
const limits = { max_width: 8192, max_height: 8192, max_pixels: 64 * 1024 * 1024 };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(result, 4);
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return result;
}

function pngWithIdats(compressedParts: readonly Uint8Array[]): Uint8Array {
  const source = Buffer.from(validPng);
  const chunks: Buffer[] = [signature];
  let offset = signature.byteLength;
  let wroteIdat = false;
  while (offset < source.byteLength) {
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    const type = source.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      if (!wroteIdat) {
        for (const compressed of compressedParts) chunks.push(chunk("IDAT", compressed));
      }
      wroteIdat = true;
    } else {
      chunks.push(source.subarray(offset, end));
    }
    offset = end;
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function pngWithIdat(compressed: Uint8Array): Uint8Array {
  return pngWithIdats([compressed]);
}

function rgbaPng({ interlaced }: { readonly interlaced: boolean }): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = interlaced ? 1 : 0;
  return new Uint8Array(Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 255]))),
    chunk("IEND", Buffer.alloc(0))
  ]));
}

type FixtureChunk = { readonly type: string; readonly data: Uint8Array };

function grayscalePng({
  beforeIdat = [],
  afterIdat = []
}: {
  readonly beforeIdat?: readonly FixtureChunk[];
  readonly afterIdat?: readonly FixtureChunk[];
}): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 0;
  const encode = (entry: FixtureChunk) => chunk(entry.type, entry.data);
  return new Uint8Array(Buffer.concat([
    signature,
    chunk("IHDR", header),
    ...beforeIdat.map(encode),
    chunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    ...afterIdat.map(encode),
    chunk("IEND", Buffer.alloc(0))
  ]));
}

describe("bounded PNG structural and decoded-stream validation", () => {
  it("accepts complete non-interlaced and Adam7 PNGs", async () => {
    await expect(validatePngStructure(validPng, limits)).resolves.toEqual({
      valid: true,
      width: 1,
      height: 1
    });
    await expect(validatePngStructure(rgbaPng({ interlaced: false }), limits))
      .resolves.toMatchObject({ valid: true, width: 1, height: 1 });
    await expect(validatePngStructure(rgbaPng({ interlaced: true }), limits))
      .resolves.toMatchObject({ valid: true, width: 1, height: 1 });
    const compressed = deflateSync(Buffer.from([0, 0, 0]));
    await expect(validatePngStructure(
      pngWithIdats([compressed.subarray(0, 3), compressed.subarray(3)]),
      limits
    )).resolves.toMatchObject({ valid: true, width: 1, height: 1 });
  });

  it("rejects a signature-only or truncated PNG", async () => {
    expect((await validatePngStructure(validPng.subarray(0, 8), limits)).valid).toBe(false);
    expect((await validatePngStructure(validPng.subarray(0, -1), limits)).valid).toBe(false);
  });

  it("rejects invalid CRC and impossible chunk boundaries", async () => {
    const badCrc = new Uint8Array(validPng);
    badCrc[29] = (badCrc[29] ?? 0) ^ 1;
    expect((await validatePngStructure(badCrc, limits)).valid).toBe(false);

    const badLength = new Uint8Array(validPng);
    badLength.set([0xff, 0xff, 0xff, 0xff], 8);
    expect((await validatePngStructure(badLength, limits)).valid).toBe(false);
  });

  it("rejects CRC-correct arbitrary, truncated, or trailing IDAT streams", async () => {
    expect((await validatePngStructure(pngWithIdat(Buffer.from("not-zlib")), limits)).valid)
      .toBe(false);

    const validCompressed = deflateSync(Buffer.from([0, 0, 0]));
    expect((await validatePngStructure(pngWithIdat(validCompressed.subarray(0, -2)), limits)).valid)
      .toBe(false);
    expect((await validatePngStructure(
      pngWithIdat(Buffer.concat([validCompressed, deflateSync(Buffer.from([0]))])),
      limits
    )).valid).toBe(false);
  });

  it("rejects exact zlib streams with truncated, overinflated, or invalid-filter scanlines", async () => {
    expect((await validatePngStructure(pngWithIdat(deflateSync(Buffer.from([0, 0]))), limits)).valid)
      .toBe(false);
    expect((await validatePngStructure(pngWithIdat(deflateSync(Buffer.from([0, 0, 0, 0]))), limits)).valid)
      .toBe(false);
    expect((await validatePngStructure(pngWithIdat(deflateSync(Buffer.from([5, 0, 0]))), limits)).valid)
      .toBe(false);
    expect((await validatePngStructure(pngWithIdat(deflateSync(Buffer.from([0, 0, 0]))), limits)).valid)
      .toBe(true);
  });

  it("enforces reserved chunk bits and ancillary ordering with valid CRCs", async () => {
    const transparency = { type: "tRNS", data: Buffer.from([0, 0]) };
    expect((await validatePngStructure(grayscalePng({
      beforeIdat: [transparency]
    }), limits)).valid).toBe(true);
    expect((await validatePngStructure(grayscalePng({
      afterIdat: [transparency]
    }), limits)).valid).toBe(false);
    expect((await validatePngStructure(grayscalePng({
      beforeIdat: [transparency, transparency]
    }), limits)).valid).toBe(false);
    expect((await validatePngStructure(grayscalePng({
      beforeIdat: [{ type: "abcD", data: Buffer.alloc(0) }]
    }), limits)).valid).toBe(false);
    expect((await validatePngStructure(grayscalePng({
      afterIdat: [{ type: "gAMA", data: Buffer.alloc(4) }]
    }), limits)).valid).toBe(false);
  });

  it("rejects structurally valid dimensions outside the provider policy", async () => {
    expect((await validatePngStructure(validPng, {
      max_width: 1,
      max_height: 1,
      max_pixels: 1
    })).valid).toBe(true);
    expect((await validatePngStructure(validPng, {
      max_width: 1,
      max_height: 1,
      max_pixels: 0
    })).valid).toBe(false);
  });
});
