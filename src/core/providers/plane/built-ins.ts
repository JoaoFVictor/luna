import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "./report-builder.js";
import {
  planeIssueContextFrom,
  planeIssueKey,
  planeIssueLocatorSummary
} from "./task-context.js";
import type { Invocation } from "../../router/invocation.js";
import { defineBuiltInStep } from "../../built-ins/registry.js";
import { finalReportMetadata } from "../../built-ins/metadata.js";
import { requiredState } from "../../built-ins/state.js";
import { builtInError } from "../../built-ins/errors.js";
import { implementationReportInputFrom } from "../../built-ins/implementation-report.js";

function planeIssueInvocationFrom(state: { invocation?: unknown }): Invocation {
  const invocation = requiredState(
    state.invocation as Invocation | undefined,
    "invocation"
  );

  try {
    planeIssueContextFrom(invocation);
  } catch {
    throw builtInError(
      "Built-in step requires Plane issue invocation",
      "built_in_unsupported"
    );
  }

  return invocation;
}

export const collectTaskContextBuiltIn = defineBuiltInStep({
  name: "collect_task_context",
  run({ state }) {
    const task = planeIssueContextFrom(planeIssueInvocationFrom(state));
    const key = planeIssueKey(task);
    const title = `Plane #${key}: ${task.title ?? key}`;

    return {
      implementation_title: title,
      implementation_subject: {
        key,
        title: task.title
      },
      change_request_body: task.description,
      plane: {
        issue_id: task.issueId,
        ...(task.sequenceId === undefined ? {} : { sequence_id: task.sequenceId }),
        workspace_slug: task.workspaceSlug,
        ...planeIssueLocatorSummary(task),
        summary: task.title ?? "",
        description: task.description,
        status: task.status,
        priority: task.priority,
        labels: task.labels
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
      invocation: planeIssueInvocationFrom(state)
    });

    return {
      json: buildImplementationReportJson(reportInput),
      markdown: buildImplementationReportMarkdown(reportInput)
    };
  }
});
