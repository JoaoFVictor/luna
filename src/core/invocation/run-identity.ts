import { slugify } from "../path-security.js";
import type { Invocation, RunIdentity } from "./types.js";

export type RunIdentityOptions = {
  attempt: number;
  date: Date;
  workflowId: string;
  runtimeRunId?: string;
  flueRunId?: string;
  nonce: string;
};

function runIdentityError(message: string): Error & { code: "invalid_run_id" } {
  const error = new Error(message) as Error & { code: "invalid_run_id" };
  error.code = "invalid_run_id";

  return error;
}

export function slugTimestamp(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hour = date.getUTCHours().toString().padStart(2, "0");
  const minute = date.getUTCMinutes().toString().padStart(2, "0");
  const second = date.getUTCSeconds().toString().padStart(2, "0");
  const millisecond = date.getUTCMilliseconds().toString().padStart(3, "0");

  return `${year}${month}${day}t${hour}${minute}${second}${millisecond}z`;
}

function invocationSlug(invocation: Invocation): string {
  return [
    invocation.source,
    invocation.event,
    invocation.repository?.owner,
    invocation.repository?.name,
    invocation.subject?.type,
    invocation.subject?.id
  ]
    .filter((part): part is string => part !== undefined)
    .map((part) => slugify(part.replace(/_/g, "-")))
    .join("-");
}

function safeIdentityPart(value: string, label: string): string {
  if (value === "") {
    throw runIdentityError(`Run id ${label} is invalid`);
  }

  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw runIdentityError(`Run id ${label} is invalid`);
  }

  const slug = slugify(value.replace(/_/g, "-"));
  if (slug === "unknown" || !/^[a-z0-9._-]+$/.test(slug)) {
    throw runIdentityError(`Run id ${label} is invalid`);
  }
  return slug;
}

function flueSuffix(flueRunId: string | undefined): string | undefined {
  if (flueRunId === undefined) {
    return undefined;
  }

  const slug = safeIdentityPart(flueRunId, "flue run id");
  return slug.slice(-12);
}

export function createRunIdentity(
  invocation: Invocation,
  options: RunIdentityOptions
): RunIdentity {
  const {
    attempt,
    date,
    workflowId,
    runtimeRunId = options.flueRunId,
    nonce
  } = options;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw runIdentityError("Run attempt must be a positive integer");
  }

  const parts = [
    slugTimestamp(date),
    safeIdentityPart(workflowId, "workflow id"),
    invocationSlug(invocation),
    `a${attempt}`,
    flueSuffix(runtimeRunId),
    safeIdentityPart(nonce, "nonce")
  ].filter((part): part is string => part !== undefined && part !== "");

  const run_id = parts.join("-");
  if (!/^[a-z0-9._-]+$/.test(run_id)) {
    throw runIdentityError("Run id contains unsafe characters");
  }

  return {
    run_id,
    ...(runtimeRunId === undefined ? {} : { flue_run_id: runtimeRunId }),
    workflow_id: workflowId,
    attempt,
    source: invocation.source,
    event: invocation.event,
    ...(invocation.action === undefined ? {} : { action: invocation.action }),
    ...(invocation.target === undefined
      ? {}
      : { route_target: invocation.target }),
    ...(invocation.subject === undefined
      ? {}
      : {
          subject: {
            type: invocation.subject.type,
            id: invocation.subject.id
          }
        }),
    started_at: date.toISOString()
  };
}
