import type {
  StudioCompiledWorkflow,
  StudioValidationDiagnostic
} from "../../contracts/validation.js";
import type { StudioResourceRef } from "../../contracts/paths.js";
import type { StudioValidationSnapshot } from "./snapshot.js";

export type StudioCanonicalValidationResult = {
  readonly revision: string;
  readonly diagnostics?: readonly StudioValidationDiagnostic[];
  readonly compiledWorkflow?: StudioCompiledWorkflow;
};

export type StudioCanonicalDefinitionValidationPort = {
  validate(input: {
    readonly snapshot: StudioValidationSnapshot;
    readonly resource: StudioResourceRef;
    readonly compile: boolean;
  }): Promise<StudioCanonicalValidationResult>;
};

export class StudioCanonicalDefinitionError extends Error {
  readonly code: string;
  readonly fieldPath?: string;
  readonly capability?: string;

  constructor(
    code: string,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly fieldPath?: string;
      readonly capability?: string;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "StudioCanonicalDefinitionError";
    this.code = code;
    this.fieldPath = options.fieldPath;
    this.capability = options.capability;
  }
}
