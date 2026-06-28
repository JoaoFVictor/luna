import type {
  InterruptRecord,
  ResumeInput
} from "./contracts.js";
import type { JsonObject } from "../json.js";
import { runtimeError } from "../errors.js";

export type InterruptAuthorizationAllowed = {
  allowed: true;
};

export type InterruptAuthorizationDenied = {
  allowed: false;
  reason?: string;
  details?: JsonObject;
};

export type InterruptAuthorizationDecision =
  | InterruptAuthorizationAllowed
  | InterruptAuthorizationDenied;

export type InterruptResumeAuthorizationPort = {
  authorizeResume(
    input: ResumeInput,
    interrupt: InterruptRecord
  ): Promise<InterruptAuthorizationDecision>;
};

export function allowInterruptResume(): InterruptResumeAuthorizationPort {
  return {
    async authorizeResume() {
      return { allowed: true };
    }
  };
}

export async function assertInterruptResumeAuthorized(
  input: ResumeInput,
  interrupt: InterruptRecord,
  authorization: InterruptResumeAuthorizationPort
): Promise<void> {
  const decision = await authorization.authorizeResume(input, interrupt);

  if (!decision.allowed) {
    throw runtimeError(
      decision.reason ?? "Interrupt resume is not authorized",
      "interrupt_unauthorized",
      {
        details: {
          interrupt_id: input.interrupt_id,
          ...decision.details
        }
      }
    );
  }
}
