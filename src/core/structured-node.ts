import { z } from "zod";
import { ArtifactStore } from "./artifact-store.js";
import { slugify } from "./path-security.js";

const RAW_OUTPUT_MAX_BYTES = 8192;

type StructuredNodeError = Error & {
  code: "agent_output_invalid";
};

type RunStructuredNodeOptions<T> = {
  nodeName: string;
  schema: z.ZodType<T>;
  artifactStore: ArtifactStore;
  execute: () => Promise<unknown>;
};

type ValidationIssue = {
  path: string;
  message: string;
};

type StoredRawOutput = {
  rawOutput: unknown;
  truncated: boolean;
};

function agentOutputInvalid(message: string): StructuredNodeError {
  const error = new Error(message) as StructuredNodeError;
  error.code = "agent_output_invalid";

  return error;
}

function parseRawOutput(rawOutput: unknown): unknown {
  if (typeof rawOutput !== "string") {
    return rawOutput;
  }

  return JSON.parse(rawOutput);
}

function summarizeError(error: unknown): ValidationIssue[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }));
  }

  if (error instanceof SyntaxError) {
    return [
      {
        path: "",
        message: error.message
      }
    ];
  }

  if (error instanceof Error) {
    return [
      {
        path: "",
        message: error.message
      }
    ];
  }

  return [
    {
      path: "",
      message: String(error)
    }
  ];
}

function truncateUtf8(value: string, maxBytes: number): StoredRawOutput {
  let byteLength = 0;
  let output = "";

  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (byteLength + codePointBytes > maxBytes) {
      return {
        rawOutput: output,
        truncated: true
      };
    }

    output += codePoint;
    byteLength += codePointBytes;
  }

  return {
    rawOutput: output,
    truncated: false
  };
}

function redactRawString(value: string): string {
  return value
    .replace(
      /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|token|secret)"?\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      "$1\"[REDACTED]\""
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|token|secret)\s*=\s*[^\s,"'}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /\b(authorization\s*:\s*)(?:Bearer\s+)?[^\s,"'}]+/gi,
      "$1[REDACTED]"
    );
}

function prepareRawOutputForArtifact(rawOutput: unknown): StoredRawOutput {
  if (typeof rawOutput !== "string") {
    return {
      rawOutput,
      truncated: false
    };
  }

  return truncateUtf8(redactRawString(rawOutput), RAW_OUTPUT_MAX_BYTES);
}

export async function runStructuredNode<T>({
  nodeName,
  schema,
  artifactStore,
  execute
}: RunStructuredNodeOptions<T>): Promise<T> {
  let lastRawOutput: unknown;
  let lastIssues: ValidationIssue[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    lastRawOutput = await execute();

    try {
      const parsedJson = parseRawOutput(lastRawOutput);
      return schema.parse(parsedJson);
    } catch (error) {
      lastIssues = summarizeError(error);
    }
  }

  const storedRawOutput = prepareRawOutputForArtifact(lastRawOutput);

  await artifactStore.writeJsonInDirectory("invalid-output", `${slugify(nodeName)}.json`, {
    node: nodeName,
    attempts: 2,
    raw_output: storedRawOutput.rawOutput,
    raw_output_truncated: storedRawOutput.truncated,
    issues: lastIssues.slice(0, 20)
  });

  throw agentOutputInvalid(`Structured output from ${nodeName} was invalid`);
}
