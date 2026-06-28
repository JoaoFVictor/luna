import {
  planeIssueContextFrom,
  planeIssueKey,
  planeIssueLocatorSummary
} from "./task-context.js";
import { requireRepository } from "../../core/invocation/helpers.js";
import type {
  ImplementationReportCommonJson,
  ImplementationReportInput,
  ImplementationTaskSummary
} from "../../capabilities/repository-change/report-builder.js";
import {
  buildImplementationReportCommonJson,
  buildImplementationReportMarkdown as buildCommonImplementationReportMarkdown
} from "../../capabilities/repository-change/report-builder.js";

export type PlaneImplementationReportJson =
  ImplementationReportCommonJson<"plane"> & {
  plane: {
    issue_id: string;
    sequence_id?: number;
    workspace_slug: string;
    project_id?: string;
    project_identifier?: string;
    issue_identifier?: number;
    priority: string;
    labels: string[];
  };
};

export function buildImplementationReportJson({
  invocation,
  ...input
}: ImplementationReportInput): PlaneImplementationReportJson {
  const issue = planeIssueContextFrom(invocation);
  const repository = requireRepository(invocation);
  const key = planeIssueKey(issue);
  const task: ImplementationTaskSummary<"plane"> = {
    provider: "plane",
    key,
    id: issue.issueId,
    url: issue.url ?? "",
    title: issue.title ?? "",
    status: issue.status
  };

  return {
    ...buildImplementationReportCommonJson({
      input: { invocation, ...input },
      task,
      repository
    }),
    plane: {
      issue_id: issue.issueId,
      ...(issue.sequenceId === undefined ? {} : { sequence_id: issue.sequenceId }),
      workspace_slug: issue.workspaceSlug,
      ...planeIssueLocatorSummary(issue),
      priority: issue.priority,
      labels: issue.labels
    }
  };
}

export function buildImplementationReportMarkdown(
  input: ImplementationReportInput
): string {
  const report = buildImplementationReportJson(input);

  return buildCommonImplementationReportMarkdown({
    report,
    taskLine: `Task: Plane #${report.task.key}`,
    summary: input.summary
  });
}
