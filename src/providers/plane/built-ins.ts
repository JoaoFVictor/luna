import {
  buildImplementationReportJson as defaultBuildImplementationReportJson,
  buildImplementationReportMarkdown as defaultBuildImplementationReportMarkdown
} from "./report-builder.js";
import {
  planeIssueContextFrom,
  planeIssueKey,
  planeIssueLocatorSummary
} from "./task-context.js";
import type { Invocation } from "../../core/router/invocation.js";
import { requiredState } from "../../core/built-ins/state.js";
import { builtInError } from "../../core/built-ins/errors.js";
import {
  implementationReportInputFrom,
  implementationReportRenderersFrom
} from "../../core/built-ins/implementation-report.js";
import type { BuiltInStepRunOptions } from "../../core/built-ins/types.js";

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

export function collectTaskContext({ state }: BuiltInStepRunOptions): unknown {
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
    invocation: planeIssueInvocationFrom(state)
  });

  return {
    json: renderers.buildJson(reportInput),
    markdown: renderers.buildMarkdown(reportInput)
  };
}
