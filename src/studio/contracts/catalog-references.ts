import { z } from "zod";

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function isPublicCatalogReference(value: string): boolean {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /^[A-Za-z]:/u.test(value) ||
    URI_SCHEME_PATTERN.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const StudioCatalogReferenceSchema = z
  .string()
  .max(1024)
  .refine(isPublicCatalogReference, {
    message: "Catalog references must be logical ids or canonical relative paths"
  });

export const StudioHttpUrlSchema = z.string().url().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  },
  "Public documentation URLs must use HTTP(S) without embedded credentials"
);
