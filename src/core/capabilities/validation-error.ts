export type CapabilityValidationCode =
  | "capability_id_invalid"
  | "capability_id_namespace"
  | "capability_registration_id_mismatch"
  | "capability_registration_forbidden"
  | "capability_composition_forbidden"
  | "capability_core_reserved"
  | "capability_manifest_forbidden"
  | "capability_presentation_invalid"
  | "pattern_registration_forbidden";

export class CapabilityValidationError extends Error {
  readonly code: CapabilityValidationCode;

  constructor(code: CapabilityValidationCode, message: string) {
    super(message);
    this.name = "CapabilityValidationError";
    this.code = code;
  }
}
