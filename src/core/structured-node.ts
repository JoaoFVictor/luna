import { z } from "zod";
import { ArtifactStore } from "./artifact-store.js";

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

  await artifactStore.writeJsonInDirectory("invalid-output", `${nodeName}.json`, {
    node: nodeName,
    attempts: 2,
    raw_output: lastRawOutput,
    issues: lastIssues.slice(0, 20)
  });

  throw agentOutputInvalid(`Structured output from ${nodeName} was invalid`);
}
