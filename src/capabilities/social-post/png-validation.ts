import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflate } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_CHUNKS = 10_000;
const INFLATE_CHUNK_BYTES = 64 * 1024;
const KNOWN_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const BEFORE_PALETTE_AND_IDAT_CHUNKS = new Set(["cHRM", "gAMA", "iCCP", "sBIT", "sRGB"]);
const BEFORE_IDAT_CHUNKS = new Set(["bKGD", "eXIf", "hIST", "pHYs", "sPLT", "tRNS"]);

export type PngValidationLimits = {
  readonly max_width: number;
  readonly max_height: number;
  readonly max_pixels: number;
};

export type PngValidationResult =
  | { readonly valid: true; readonly width: number; readonly height: number }
  | { readonly valid: false; readonly width: number; readonly height: number };

type ParsedPng = {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlaceMethod: number;
  readonly imageData: readonly Uint8Array[];
  readonly compressedBytes: number;
};

type ScanlinePass = {
  readonly rows: number;
  readonly rowBytes: number;
};

const CRC_TABLE = (() => {
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
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validBitDepth(bitDepth: number, colorType: number): boolean {
  const allowed = new Map<number, readonly number[]>([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]]
  ]);
  return allowed.get(colorType)?.includes(bitDepth) === true;
}

function invalid(width = 0, height = 0): PngValidationResult {
  return { valid: false, width, height };
}

function parsePng(bytes: Uint8Array, limits: PngValidationLimits): ParsedPng | undefined {
  if (
    bytes.byteLength < 45 ||
    !Buffer.from(bytes.subarray(0, PNG_SIGNATURE.byteLength)).equals(PNG_SIGNATURE)
  ) {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const imageData: Uint8Array[] = [];
  let compressedBytes = 0;
  let offset = PNG_SIGNATURE.byteLength;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let bitDepth = -1;
  let colorType = -1;
  let interlaceMethod = -1;
  let sawHeader = false;
  let sawPalette = false;
  let paletteEntries = 0;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawTransparency = false;

  while (offset < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS || bytes.byteLength - offset < 12) return undefined;
    const length = view.getUint32(offset, false);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) return undefined;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (![...typeBytes].every((value) =>
      (value >= 65 && value <= 90) || (value >= 97 && value <= 122))) return undefined;
    // PNG reserves bit 5 of the third chunk-type byte. Lowercase means a
    // future incompatible definition and must fail closed.
    if ((typeBytes[2] ?? 0) < 65 || (typeBytes[2] ?? 0) > 90) return undefined;
    const type = Buffer.from(typeBytes).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = view.getUint32(offset + 8 + length, false);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return undefined;
    if ((typeBytes[0] ?? 0) >= 65 && (typeBytes[0] ?? 0) <= 90 &&
      !KNOWN_CRITICAL_CHUNKS.has(type)) return undefined;

    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = view.getUint32(offset + 8, false);
      height = view.getUint32(offset + 12, false);
      bitDepth = data[8] ?? -1;
      colorType = data[9] ?? -1;
      interlaceMethod = data[12] ?? -1;
      const pixels = width * height;
      if (
        width < 1 || height < 1 ||
        width > limits.max_width || height > limits.max_height ||
        !Number.isSafeInteger(pixels) || pixels > limits.max_pixels ||
        !validBitDepth(bitDepth, colorType) ||
        data[10] !== 0 || data[11] !== 0 ||
        (interlaceMethod !== 0 && interlaceMethod !== 1)
      ) return undefined;
      sawHeader = true;
    } else if (type === "IHDR") {
      return undefined;
    } else if (type === "PLTE") {
      paletteEntries = length / 3;
      if (sawPalette || sawImageData || length === 0 || length % 3 !== 0 || length > 768 ||
        colorType === 0 || colorType === 4 ||
        (colorType === 3 && paletteEntries > 2 ** bitDepth)) return undefined;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || (colorType === 3 && !sawPalette)) return undefined;
      sawImageData = true;
      imageData.push(data);
      compressedBytes += data.byteLength;
      if (!Number.isSafeInteger(compressedBytes)) return undefined;
    } else {
      if (BEFORE_PALETTE_AND_IDAT_CHUNKS.has(type) && (sawPalette || sawImageData)) {
        return undefined;
      }
      if (BEFORE_IDAT_CHUNKS.has(type) && sawImageData) return undefined;
      if (type === "hIST" && !sawPalette) return undefined;
      if (type === "bKGD" && colorType === 3 && !sawPalette) return undefined;
      if (type === "tRNS") {
        if (sawTransparency || colorType === 4 || colorType === 6) return undefined;
        if (
          (colorType === 0 && length !== 2) ||
          (colorType === 2 && length !== 6) ||
          (colorType === 3 && (!sawPalette || length < 1 || length > paletteEntries))
        ) return undefined;
        sawTransparency = true;
      }
      if (sawImageData) imageDataEnded = true;
      if (type === "IEND") {
        if (length !== 0 || !sawImageData || chunkEnd !== bytes.byteLength) return undefined;
        return {
          width,
          height,
          bitDepth,
          colorType,
          interlaceMethod,
          imageData,
          compressedBytes
        };
      }
    }
    offset = chunkEnd;
  }

  return undefined;
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function scanlinePasses(png: ParsedPng): readonly ScanlinePass[] | undefined {
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4]
  ]).get(png.colorType);
  if (channels === undefined) return undefined;
  const bitsPerPixel = channels * png.bitDepth;
  const adam7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2]
  ] as const;
  const geometries = png.interlaceMethod === 0
    ? [[0, 0, 1, 1] as const]
    : adam7;
  const passes: ScanlinePass[] = [];
  for (const [startX, startY, stepX, stepY] of geometries) {
    const columns = passSize(png.width, startX, stepX);
    const rows = passSize(png.height, startY, stepY);
    if (columns === 0 || rows === 0) continue;
    const rowBytes = Math.ceil((columns * bitsPerPixel) / 8);
    if (!Number.isSafeInteger(rowBytes) || rowBytes < 1) return undefined;
    passes.push({ rows, rowBytes });
  }
  return passes;
}

async function validateImageData(png: ParsedPng): Promise<boolean> {
  const passes = scanlinePasses(png);
  if (passes === undefined || passes.length === 0 || png.compressedBytes === 0) return false;
  const expectedDecodedBytes = passes.reduce(
    (total, pass) => total + pass.rows * (pass.rowBytes + 1),
    0
  );
  if (!Number.isSafeInteger(expectedDecodedBytes) || expectedDecodedBytes < 1) return false;

  let passIndex = 0;
  let rowsRemaining = passes[0]?.rows ?? 0;
  let rowOffset = 0;
  let decodedBytes = 0;
  let streamValid = true;

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      let cursor = 0;
      while (cursor < chunk.byteLength) {
        const pass = passes[passIndex];
        if (pass === undefined) {
          streamValid = false;
          callback(new Error("png_decoded_stream_exceeds_ihdr"));
          return;
        }
        if (rowOffset === 0) {
          if ((chunk[cursor] ?? 255) > 4) {
            streamValid = false;
            callback(new Error("png_invalid_scanline_filter"));
            return;
          }
          cursor += 1;
          decodedBytes += 1;
          rowOffset = 1;
        }
        const rowLength = pass.rowBytes + 1;
        const consumed = Math.min(chunk.byteLength - cursor, rowLength - rowOffset);
        cursor += consumed;
        decodedBytes += consumed;
        rowOffset += consumed;
        if (rowOffset === rowLength) {
          rowOffset = 0;
          rowsRemaining -= 1;
          if (rowsRemaining === 0) {
            passIndex += 1;
            rowsRemaining = passes[passIndex]?.rows ?? 0;
          }
        }
      }
      callback();
    }
  });
  const inflater = createInflate({ chunkSize: INFLATE_CHUNK_BYTES });
  const source = Readable.from((async function* () {
    for (const chunk of png.imageData) yield chunk;
  })(), { objectMode: false });

  try {
    await pipeline(source, inflater, sink);
  } catch {
    return false;
  }
  return streamValid &&
    decodedBytes === expectedDecodedBytes &&
    passIndex === passes.length &&
    rowOffset === 0 &&
    inflater.bytesWritten === png.compressedBytes;
}

/**
 * Validates every PNG chunk/CRC and decodes its single zlib stream with bounded
 * memory. Decoded bytes must exactly match the IHDR scanline layout (including
 * Adam7 passes), so truncated streams, trailing streams, invalid filters, and
 * decompression bombs fail closed before provider I/O.
 */
export async function validatePngStructure(
  bytes: Uint8Array,
  limits: PngValidationLimits
): Promise<PngValidationResult> {
  const parsed = parsePng(bytes, limits);
  if (parsed === undefined) return invalid();
  return await validateImageData(parsed)
    ? { valid: true, width: parsed.width, height: parsed.height }
    : invalid(parsed.width, parsed.height);
}
