export const repositoryEmptyInputSchema = {
  type: "object",
  additionalProperties: false
} as const;

export const repositoryTextOutputSchema = { type: "string" } as const;

export const repositoryFilePathSchema = { type: "string", minLength: 1 } as const;

export const repositoryReadFileInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: repositoryFilePathSchema,
    max_bytes: { type: "number", minimum: 1 }
  }
} as const;

export const repositoryReadFileOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content", "bytes", "truncated"],
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    bytes: { type: "number" },
    truncated: { type: "boolean" }
  }
} as const;

export const repositoryWriteFileInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content"],
  properties: {
    path: repositoryFilePathSchema,
    content: { type: "string" },
    create_dirs: { type: "boolean" }
  }
} as const;

export const repositoryWriteFileOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "bytes"],
  properties: {
    path: { type: "string" },
    bytes: { type: "number" }
  }
} as const;

export const repositoryDeleteFileInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: repositoryFilePathSchema,
    missing_ok: { type: "boolean" }
  }
} as const;

export const repositoryDeleteFileOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "deleted"],
  properties: {
    path: { type: "string" },
    deleted: { type: "boolean" }
  }
} as const;
