import { z } from "zod";
import { assertJsonValue, type JsonValue } from "../json/value.js";

export type StudioExample = {
  readonly title: string;
  readonly description?: string;
  readonly value: JsonValue;
};

export type StudioFieldControl =
  | "text"
  | "textarea"
  | "number"
  | "switch"
  | "select"
  | "json";

type StudioFieldMetadata = {
  readonly label?: string;
  readonly description?: string;
};

type StudioMetadataOnlyFieldHint = StudioFieldMetadata & {
  readonly control?: never;
  readonly placeholder?: never;
  readonly option_labels?: never;
};

type StudioPlaceholder = {
  /** Empty string intentionally suppresses placeholder copy. */
  readonly placeholder?: string;
};

type StudioInputFieldHint = StudioFieldMetadata & StudioPlaceholder & {
  readonly control: "text" | "textarea" | "number" | "json";
  readonly option_labels?: never;
};

type StudioSwitchFieldHint = StudioFieldMetadata & {
  readonly control: "switch";
  readonly placeholder?: never;
  readonly option_labels?: never;
};

type StudioSelectFieldHint = StudioFieldMetadata & StudioPlaceholder & {
  readonly control: "select";
  readonly option_labels?: Readonly<Record<string, string>>;
};

export type StudioFieldHint =
  | StudioMetadataOnlyFieldHint
  | StudioInputFieldHint
  | StudioSwitchFieldHint
  | StudioSelectFieldHint;

export type StudioFieldPointer = "" | `/${string}`;

export type StudioFieldHints = Readonly<
  Partial<Record<StudioFieldPointer, StudioFieldHint>>
>;

export type StudioPresentation = {
  readonly title: string;
  readonly summary?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly icon?: string;
  readonly examples?: readonly StudioExample[];
  readonly field_hints?: StudioFieldHints;
};

export type StudioPresentable = {
  readonly presentation?: StudioPresentation;
};

const NonBlankPresentationStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  "Presentation strings must not be blank"
);

function isCanonicalJsonPointer(value: string): boolean {
  return (
    value === "" ||
    (value.startsWith("/") &&
      value
        .slice(1)
        .split("/")
        .every((token) => !/~(?:[^01]|$)/u.test(token)))
  );
}

export const StudioFieldPointerSchema = z.string().refine(
  isCanonicalJsonPointer,
  "Field hint keys must be canonical RFC 6901 JSON Pointers"
);

const StudioJsonValueSchema = z.custom<JsonValue>((value) => {
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}, "Example values must contain only JSON values");

export const StudioPresentationExampleSchema: z.ZodType<StudioExample> = z
  .object({
    title: NonBlankPresentationStringSchema,
    description: NonBlankPresentationStringSchema.optional(),
    value: StudioJsonValueSchema
  })
  .strict();

const StudioFieldMetadataShape = {
  label: NonBlankPresentationStringSchema.optional(),
  description: NonBlankPresentationStringSchema.optional()
} as const;

const StudioMetadataOnlyFieldHintSchema = z
  .object(StudioFieldMetadataShape)
  .strict();

const StudioInputFieldHintSchema = z
  .object({
    ...StudioFieldMetadataShape,
    control: z.enum(["text", "textarea", "number", "json"]),
    placeholder: z.string().optional()
  })
  .strict();

const StudioSwitchFieldHintSchema = z
  .object({
    ...StudioFieldMetadataShape,
    control: z.literal("switch")
  })
  .strict();

const StudioSelectFieldHintSchema = z
  .object({
    ...StudioFieldMetadataShape,
    control: z.literal("select"),
    placeholder: z.string().optional(),
    option_labels: z
      .record(NonBlankPresentationStringSchema)
      .optional()
  })
  .strict();

export const StudioFieldHintSchema: z.ZodType<StudioFieldHint> = z.union([
  StudioMetadataOnlyFieldHintSchema,
  StudioInputFieldHintSchema,
  StudioSwitchFieldHintSchema,
  StudioSelectFieldHintSchema
]);

export const StudioPresentationSchema: z.ZodType<StudioPresentation> = z
  .object({
    title: NonBlankPresentationStringSchema,
    summary: NonBlankPresentationStringSchema.optional(),
    category: NonBlankPresentationStringSchema.optional(),
    tags: z.array(NonBlankPresentationStringSchema).optional(),
    icon: NonBlankPresentationStringSchema.optional(),
    examples: z.array(StudioPresentationExampleSchema).optional(),
    field_hints: z
      .record(StudioFieldPointerSchema, StudioFieldHintSchema)
      .optional()
  })
  .strict();
