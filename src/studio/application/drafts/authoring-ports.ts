import type { StudioResourceRef } from "../../contracts/paths.js";
import type { StudioPath } from "../../contracts/paths.js";

export type StudioAuthoringSourceFile = {
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
};
export type StudioAuthoringSourcePort = {
  read(
    file: StudioPath,
    options: { readonly maxBytes: number }
  ): Promise<StudioAuthoringSourceFile | undefined>;
};

export type StudioResourceRevisionPort = {
  current(resource: StudioResourceRef): Promise<string | null>;
};

export type StudioCatalogFingerprintPort = {
  technical(): Promise<string> | string;
  presentation(): Promise<string> | string;
};

export type StudioModelProfileCatalogPort = {
  ids(): Promise<readonly string[]>;
};
