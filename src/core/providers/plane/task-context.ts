import { z } from "zod";
import {
  codedError,
  parsePayload,
  requireSubject
} from "../../invocation/helpers.js";
import type {
  InvocationRepository,
  NormalizedInvocation
} from "../../router/invocation.js";

const PlanePayloadBaseSchema = z
  .object({
    instance_id: z.string().min(1),
    workspace_slug: z.string().min(1),
    issue_id: z.string().min(1),
    sequence_id: z.number().int().optional(),
    description: z.string(),
    status: z.string(),
    priority: z.string(),
    labels: z.array(z.string()),
    repository_hint_source: z.string().min(1).optional()
  });

const PlaneProjectIssuePayloadSchema = PlanePayloadBaseSchema.extend({
  project_id: z.string().min(1)
}).strict();

const PlaneWorkItemPayloadSchema = PlanePayloadBaseSchema.extend({
  project_identifier: z.string().min(1),
  issue_identifier: z.number().int()
}).strict();

const PlanePayloadSchema = z.union([
  PlaneProjectIssuePayloadSchema,
  PlaneWorkItemPayloadSchema
]);

type PlaneProjectIssueLocator = {
  kind: "project_issue";
  projectId: string;
};

type PlaneWorkItemLocator = {
  kind: "work_item";
  projectIdentifier: string;
  issueIdentifier: number;
};

export type PlaneIssueLocator =
  | PlaneProjectIssueLocator
  | PlaneWorkItemLocator;

export type PlaneIssueContext = PlaneIssueLocator & {
  instanceId: string;
  workspaceSlug: string;
  issueId: string;
  sequenceId?: number;
  url?: string;
  title?: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  repository?: InvocationRepository;
};

export type PlaneIssueLocatorSummary =
  | { project_id: string }
  | { project_identifier: string; issue_identifier: number };

function planeIssueContextInvalid(message: string): Error & { code: string } {
  return codedError(message, "plane_issue_context_invalid");
}

export function planeIssueKey(issue: PlaneIssueContext): string {
  if (issue.kind === "work_item") {
    return `${issue.projectIdentifier}-${issue.issueIdentifier}`;
  }

  return issue.sequenceId === undefined ? issue.issueId : String(issue.sequenceId);
}

export function planeIssueLocatorSummary(
  issue: PlaneIssueContext
): PlaneIssueLocatorSummary {
  if (issue.kind === "project_issue") {
    return { project_id: issue.projectId };
  }

  return {
    project_identifier: issue.projectIdentifier,
    issue_identifier: issue.issueIdentifier
  };
}

export function planeIssueContextFrom(
  invocation: NormalizedInvocation
): PlaneIssueContext {
  if (invocation.source !== "plane" || invocation.event !== "issue") {
    throw planeIssueContextInvalid("Invocation is not a Plane issue event");
  }

  const subject = requireSubject(invocation, "plane_issue");
  const plane = parsePayload(
    invocation,
    "plane",
    PlanePayloadSchema,
    "plane_issue_context_invalid"
  );

  return {
    ...("project_id" in plane
      ? { kind: "project_issue" as const, projectId: plane.project_id }
      : {
          kind: "work_item" as const,
          projectIdentifier: plane.project_identifier,
          issueIdentifier: plane.issue_identifier
        }),
    instanceId: plane.instance_id,
    workspaceSlug: plane.workspace_slug,
    issueId: plane.issue_id,
    sequenceId: plane.sequence_id,
    url: subject.url,
    title: subject.title,
    description: plane.description,
    status: plane.status,
    priority: plane.priority,
    labels: plane.labels,
    ...(invocation.repository === undefined
      ? {}
      : { repository: invocation.repository })
  };
}
