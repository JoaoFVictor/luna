import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "./report-builder.js";
import { jiraIssueContextFrom } from "./task-context.js";
import type { Invocation } from "../../core/router/invocation.js";
import { requiredState } from "../../core/built-ins/state.js";
import { builtInError } from "../../core/built-ins/errors.js";
import {
  implementationReportInputFrom,
  implementationReportRenderersFrom
} from "../../core/built-ins/implementation-report.js";
import type { BuiltInStepRunOptions } from "../../core/built-ins/types.js";

function jiraIssueInvocationFrom(state: { invocation?: unknown }): Invocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  try {
    jiraIssueContextFrom(invocation);
  } catch {
    throw builtInError(
      "Built-in step requires Jira issue invocation",
      "built_in_unsupported"
    );
  }

  return invocation;
}

export function collectTaskContext({ state }: BuiltInStepRunOptions): unknown {
  const task = jiraIssueContextFrom(jiraIssueInvocationFrom(state));
  const title = `${task.issueKey}: ${task.title ?? task.issueKey}`;

  return {
    implementation_title: title,
    implementation_subject: {
      key: task.issueKey,
      title: task.title
    },
    change_request_body: task.description,
    jira: {
      issue_key: task.issueKey,
      summary: task.title ?? "",
      description: task.description,
      acceptance_criteria: task.acceptanceCriteria
    },
    ...(task.repository === undefined ? {} : { repository: task.repository })
  };
}

export function finalImplementationReport({
  state,
  input,
  dependencies = {},
  observabilitySummary
}: BuiltInStepRunOptions): unknown {
  const renderers = implementationReportRenderersFrom({
    dependencies,
    defaultBuildJson: defaultBuildImplementationReportJson,
    defaultBuildMarkdown: defaultBuildImplementationReportMarkdown
  });
  const reportInput = implementationReportInputFrom({
    state,
    input,
    dependencies,
    observabilitySummary,
    invocation: jiraIssueInvocationFrom(state)
  });

  return {
    json: renderers.buildJson(reportInput),
    markdown: renderers.buildMarkdown(reportInput)
  };
}
