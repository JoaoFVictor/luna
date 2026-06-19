import { slugify } from "./path-security.js";
import type { Invocation, RunIdentity } from "./types.js";

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

export function createRunIdentity(
  invocation: Invocation,
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

  const identity: RunIdentity = {
    run_id,
    attempt,
    source: invocation.source,
    event: invocation.event
  };

  if (invocation.action !== undefined) {
    identity.action = invocation.action;
  }

  if (invocation.target !== undefined) {
    identity.route_target = invocation.target;
  }

  if (invocation.subject !== undefined) {
    identity.subject = {
      type: invocation.subject.type,
      id: invocation.subject.id
    };
  }

  return identity;
}
