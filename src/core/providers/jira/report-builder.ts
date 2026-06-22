import { jiraIssueContextFrom } from "./task-context.js";
import { requireRepository } from "../../invocation/helpers.js";
import type {
  ImplementationReportCommonJson,
  ImplementationReportInput,
  ImplementationTaskSummary
} from "../../reports/implementation-report.js";
import {
  buildImplementationReportCommonJson,
  buildImplementationReportMarkdown as buildCommonImplementationReportMarkdown
} from "../../reports/implementation-report.js";

export type ImplementationReportJson =
  ImplementationReportCommonJson<"jira"> & {
  jira: {
    key: string;
    url: string;
    summary: string;
    status: string;
  };
};

export function buildImplementationReportJson({
  invocation,
  ...input
}: ImplementationReportInput): ImplementationReportJson {
  const issue = jiraIssueContextFrom(invocation);
  const repository = requireRepository(invocation);
  const task: ImplementationTaskSummary<"jira"> = {
    provider: "jira",
    key: issue.issueKey,
    id: issue.issueKey,
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
    jira: {
      key: issue.issueKey,
      url: issue.url ?? "",
      summary: issue.title ?? "",
      status: issue.status
    }
  };
}

export function buildImplementationReportMarkdown(
  input: ImplementationReportInput
): string {
  const report = buildImplementationReportJson(input);

  return buildCommonImplementationReportMarkdown({
    report,
    taskLine: `Jira: ${report.jira.key}`,
    summary: input.summary
  });
}
