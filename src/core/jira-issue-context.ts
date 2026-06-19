import { z } from "zod";
import {
  codedError,
  parsePayload,
  requireRepository,
  requireSubject
} from "./invocation-helpers.js";
import type {
  InvocationRepository,
  NormalizedInvocation
} from "./types.js";

const JiraPayloadSchema = z
  .object({
    instance_id: z.string().min(1),
    description: z.string().min(1),
    acceptance_criteria: z.string(),
    status: z.string().min(1),
    issue_type: z.string().min(1)
  })
  .strict();

export type JiraIssueContext = {
  instanceId: string;
  issueKey: string;
  url?: string;
  title?: string;
  description: string;
  acceptanceCriteria: string;
  status: string;
  issueType: string;
  repository: InvocationRepository;
};

function jiraIssueContextInvalid(message: string): Error & { code: string } {
  return codedError(message, "jira_issue_context_invalid");
}

export function jiraIssueContextFrom(invocation: NormalizedInvocation): JiraIssueContext {
  if (invocation.source !== "jira" || invocation.event !== "issue") {
    throw jiraIssueContextInvalid("Invocation is not a Jira issue event");
  }

  const repository = requireRepository(invocation);
  const subject = requireSubject(invocation, "jira_issue");
  const jira = parsePayload(
    invocation,
    "jira",
    JiraPayloadSchema,
    "jira_issue_context_invalid"
  );

  return {
    instanceId: jira.instance_id,
    issueKey: subject.id,
    url: subject.url,
    title: subject.title,
    description: jira.description,
    acceptanceCriteria: jira.acceptance_criteria,
    status: jira.status,
    issueType: jira.issue_type,
    repository
  };
}
