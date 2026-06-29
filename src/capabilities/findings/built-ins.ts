import { validateFindingEvidence as defaultValidateFindingEvidence } from "./evidence-validator.js";
import type { RepoContext } from "../git/diff/types.js";
import type {
  Finding,
  FindingsPayload
} from "../../core/findings/types.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  findingsFrom,
  requiredInput,
  resolvedInput
} from "../../core/built-ins/state.js";
import type {
  BuiltInStepDependencies,
  MaybePromise
} from "../../core/built-ins/types.js";

type FindingsBuiltInDependencies = BuiltInStepDependencies & {
  validateFindingEvidence?: (
    repoContext: RepoContext,
    findings: readonly Finding[]
  ) => MaybePromise<readonly Finding[]>;
};

export const validateFindingEvidenceBuiltIn = defineBuiltInStep<
  "findings.validate_evidence",
  FindingsBuiltInDependencies
>({
  name: "findings.validate_evidence",
  async run({ state, input, dependencies = {} }) {
    const validateFindingEvidence =
      dependencies.validateFindingEvidence ?? defaultValidateFindingEvidence;
    const resolved = resolvedInput(input, state);
    const repoContext = requiredInput(
      resolved.repo_context as RepoContext | undefined,
      "repo_context"
    );
    const findingsPayload = requiredInput(resolved.findings, "findings");
    const findings = findingsFrom(findingsPayload);
    const validatedFindings = await validateFindingEvidence(repoContext, findings);

    return {
      ...(typeof findingsPayload === "object" &&
      findingsPayload !== null &&
      !Array.isArray(findingsPayload) &&
      typeof (findingsPayload as FindingsPayload).summary === "string"
        ? { summary: (findingsPayload as FindingsPayload).summary }
        : {}),
      findings: validatedFindings
    };
  }
});
