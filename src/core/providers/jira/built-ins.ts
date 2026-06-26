import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "./report-builder.js";
import { jiraIssueContextFrom } from "./task-context.js";
import type { Invocation } from "../../router/invocation.js";
import { defineBuiltInStep } from "../../built-ins/registry.js";
import { finalReportMetadata } from "../../built-ins/metadata.js";
import { requiredState } from "../../built-ins/state.js";
import { builtInError } from "../../built-ins/errors.js";
import { implementationReportInputFrom } from "../../built-ins/implementation-report.js";

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

export const collectTaskContextBuiltIn = defineBuiltInStep({
  name: "collect_task_context",
  run({ state }) {
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
});

export const finalImplementationReportBuiltIn = defineBuiltInStep({
  name: "final_implementation_report",
  metadata: finalReportMetadata,
  run({ state, input, dependencies = {}, observabilitySummary }) {
    const buildImplementationReportJson =
      dependencies.buildImplementationReportJson ??
      defaultBuildImplementationReportJson;
    const buildImplementationReportMarkdown =
      dependencies.buildImplementationReportMarkdown ??
      defaultBuildImplementationReportMarkdown;
    const reportInput = implementationReportInputFrom({
      state,
      input,
      dependencies,
      observabilitySummary,
      invocation: jiraIssueInvocationFrom(state)
    });

    return {
      json: buildImplementationReportJson(reportInput),
      markdown: buildImplementationReportMarkdown(reportInput)
    };
  }
});
