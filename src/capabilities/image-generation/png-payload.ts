import { Buffer } from "node:buffer";

export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BASE64_CHARACTERS =
  4 * Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3);

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type GeneratedPngPayloadValidation =
  | { readonly valid: true; readonly bytes: Buffer }
  | { readonly valid: false; readonly reason: "invalid_base64" | "oversized" | "invalid_png" };

export function validateGeneratedPngBase64(
  value: string,
  maxImageBytes: number
): GeneratedPngPayloadValidation {
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < PNG_SIGNATURE.length) {
    return { valid: false, reason: "oversized" };
  }
  const maxBase64Characters = 4 * Math.ceil(maxImageBytes / 3);
  if (
    value.length === 0 ||
    value.length > maxBase64Characters ||
    Buffer.byteLength(value, "utf8") > maxBase64Characters
  ) {
    return { valid: false, reason: "oversized" };
  }
  if (!STANDARD_BASE64.test(value)) {
    return { valid: false, reason: "invalid_base64" };
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    return { valid: false, reason: "invalid_base64" };
  }
  if (bytes.byteLength > maxImageBytes) {
    return { valid: false, reason: "oversized" };
  }
  if (
    bytes.byteLength < PNG_SIGNATURE.byteLength ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    return { valid: false, reason: "invalid_png" };
  }
  return { valid: true, bytes };
}
