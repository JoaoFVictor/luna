import { slugify } from "./path-security.js";
import type { Invocation, RunIdentity } from "./types.js";

type InvocationWithOptionalId = Invocation & {
  invocation_id?: unknown;
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

  return `${year}${month}${day}t${hour}${minute}${second}z`;
}

function invocationSlug(invocation: InvocationWithOptionalId): string {
  if (typeof invocation.invocation_id === "string" && invocation.invocation_id !== "") {
    return slugify(invocation.invocation_id);
  }

  if (invocation.target === "jira_task") {
    return slugify(
      `${invocation.repository.provider}-${invocation.repository.owner}-${invocation.repository.name}-jira-${invocation.jira.issue_key}`
    );
  }

  return slugify(
    `${invocation.owner}-${invocation.repo}-pr-${invocation.pull_number}`
  );
}

export function createRunIdentity(
  invocation: InvocationWithOptionalId,
  attempt: number,
  date = new Date()
): RunIdentity {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw runIdentityError("Run attempt must be a positive integer");
  }

  const run_id = `${slugTimestamp(date)}-${invocationSlug(invocation)}-a${attempt}`;

  if (!/^[a-z0-9._-]+$/.test(run_id)) {
    throw runIdentityError("Run id contains unsafe characters");
  }

  return {
    run_id,
    target: invocation.target,
    started_at: date.toISOString()
  };
}
