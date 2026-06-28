import path from "node:path";
import { z } from "zod";
import { loadYamlFile } from "../../core/config/loader.js";
import {
  loadPlaneAuth,
  planeAuthForInstance,
  type PlaneAuth
} from "./auth.js";
import {
  PlaneConfigSchema,
  type PlaneConfig
} from "./config.js";
import { repositoryHintFromLabels } from "../repository-hints/repository-reference.js";
import {
  InvocationSchema,
  type Invocation
} from "../../core/router/invocation.js";
import type { AdapterInput, InputAdapter } from "../../adapters/types.js";

export type PlaneIssueRequest = {
  instance: PlaneInstanceConfig;
  workspaceSlug: string;
  auth: PlaneAuth;
  locator: PlaneIssueLocator;
  fetch: typeof fetch;
};

export type PlaneAdapterError = Error & {
  code:
    | "invalid_plane_task_url"
    | "plane_instance_not_configured"
    | "plane_repository_hint_invalid"
    | "plane_issue_fetch_failed"
    | "plane_issue_invalid_response";
  cause?: unknown;
};

type PlaneInstanceConfig = PlaneConfig["instances"][number];

type PlaneIssueLocator =
  | {
      kind: "project_issue";
      projectId: string;
      issueId: string;
      canonicalUrl: string;
    }
  | {
      kind: "work_item_identifier";
      projectIdentifier: string;
      issueIdentifier: number;
      workItemKey: string;
      canonicalUrl: string;
    };

const PlaneIssueSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sequence_id: z.number().int().optional(),
    description_stripped: z.string().optional(),
    description_html: z.string().optional(),
    description: z.unknown().optional(),
    priority: z.string().optional(),
    state: z.unknown().optional(),
    labels: z.array(z.unknown()).optional()
  })
  .passthrough();

function adapterError(
  code: PlaneAdapterError["code"],
  message: string,
  cause?: unknown
): PlaneAdapterError {
  const error = new Error(message, { cause }) as PlaneAdapterError;
  error.code = code;
  error.cause = cause;

  return error;
}

function parsePlaneTaskUrl(url: string): {
  parsed: URL;
  workspaceSlug: string;
  locator: PlaneIssueLocator;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw adapterError("invalid_plane_task_url", `Invalid Plane task URL: ${url}`, cause);
  }

  if (parsed.protocol !== "https:") {
    throw adapterError("invalid_plane_task_url", `Expected HTTPS Plane task URL: ${url}`);
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw adapterError(
      "invalid_plane_task_url",
      "Plane task URL must not include credentials"
    );
  }

  const [workspaceSlug, firstSegment, secondSegment, thirdSegment, fourthSegment, ...extra] =
    parsed.pathname.split("/").filter(Boolean);

  if (workspaceSlug === undefined) {
    throw adapterError("invalid_plane_task_url", `Expected Plane task URL: ${url}`);
  }

  if (
    firstSegment === "projects" &&
    secondSegment !== undefined &&
    thirdSegment === "issues" &&
    fourthSegment !== undefined &&
    extra.length === 0
  ) {
    return {
      parsed,
      workspaceSlug,
      locator: {
        kind: "project_issue",
        projectId: secondSegment,
        issueId: fourthSegment,
        canonicalUrl: `${parsed.origin}/${workspaceSlug}/projects/${secondSegment}/issues/${fourthSegment}`
      }
    };
  }

  if (
    firstSegment === "browse" &&
    secondSegment !== undefined &&
    thirdSegment === undefined &&
    fourthSegment === undefined &&
    extra.length === 0
  ) {
    const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(secondSegment);
    if (match !== null) {
      return {
        parsed,
        workspaceSlug,
        locator: {
          kind: "work_item_identifier",
          projectIdentifier: match[1],
          issueIdentifier: Number(match[2]),
          workItemKey: secondSegment,
          canonicalUrl: `${parsed.origin}/${workspaceSlug}/browse/${secondSegment}`
        }
      };
    }
  }

  throw adapterError("invalid_plane_task_url", `Expected Plane task URL: ${url}`);
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function apiBaseUrlOf(instance: PlaneInstanceConfig): string {
  const baseUrl = new URL(instance.base_url);
  if (baseUrl.hostname === "app.plane.so") {
    baseUrl.hostname = "api.plane.so";
  }

  return baseUrl.toString();
}

function findPlaneInstance(plane: PlaneConfig, url: URL): PlaneInstanceConfig {
  const instance = plane.instances.find(
    (candidate) => originOf(candidate.base_url) === url.origin
  );

  if (instance === undefined) {
    throw adapterError(
      "plane_instance_not_configured",
      `Plane instance is not configured for origin: ${url.origin}`
    );
  }

  return instance;
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join(" ");
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ownText = typeof record.text === "string" ? record.text : "";
    const contentText = textFromValue(record.content);
    const combined = `${ownText}${contentText ? ` ${contentText}` : ""}`;

    return combined.trim();
  }

  return "";
}

function compactText(value: unknown): string {
  return textFromValue(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function nameOf(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") {
      return record.name;
    }
  }

  return compactText(value);
}

function labelNames(values: unknown[] | undefined): string[] {
  if (values === undefined) {
    return [];
  }

  return values.map(nameOf).filter((label) => label.length > 0);
}

async function defaultFetchIssue({
  instance,
  workspaceSlug,
  auth,
  locator,
  fetch
}: PlaneIssueRequest): Promise<unknown> {
  const url = new URL(issuePath(workspaceSlug, locator), apiBaseUrlOf(instance));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-API-Key": auth.api_key
    }
  });

  if (!response.ok) {
    throw adapterError(
      "plane_issue_fetch_failed",
      `Failed to fetch Plane issue ${issueLabel(locator)}: HTTP ${response.status}`
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw adapterError(
      "plane_issue_invalid_response",
      `Plane issue ${issueLabel(locator)} response was not valid JSON`,
      cause
    );
  }
}

async function loadPlaneTaskUrlInvocation(
  input: AdapterInput,
  context: Parameters<InputAdapter["load"]>[1]
): Promise<Invocation> {
  const { parsed, workspaceSlug, locator } = parsePlaneTaskUrl(input.value);
  const plane = await loadYamlFile(
    path.join(context.configRoot, "plane.yaml"),
    PlaneConfigSchema
  );
  const instance = findPlaneInstance(plane, parsed);
  const auth = planeAuthForInstance(await loadPlaneAuth(context.configRoot), instance.id);
  const issueResponse = await defaultFetchIssue({
    instance,
    workspaceSlug,
    auth,
    locator,
    fetch: context.fetch
  });
  const parsedIssue = PlaneIssueSchema.safeParse(issueResponse);

  if (!parsedIssue.success) {
    throw adapterError(
      "plane_issue_invalid_response",
      parsedIssue.error.message,
      parsedIssue.error
    );
  }

  const issue = parsedIssue.data;
  const labels = labelNames(issue.labels);
  let repositoryHint;
  try {
    repositoryHint =
      instance.repository_hint === undefined
        ? undefined
        : repositoryHintFromLabels(labels);
  } catch (cause) {
    throw adapterError(
      "plane_repository_hint_invalid",
      "Plane repository hint label is invalid",
      cause
    );
  }

  return InvocationSchema.parse({
    version: "2026-06",
    source: "plane",
    event: "issue",
    action: "selected",
    ...(repositoryHint === undefined
      ? {}
      : { repository: repositoryHint.repository }),
    subject: {
      type: "plane_issue",
      id: issue.id,
      url: locator.canonicalUrl,
      title: issue.name
    },
    payload: {
      plane: {
        instance_id: instance.id,
        workspace_slug: workspaceSlug,
        ...payloadLocator(locator),
        issue_id: issue.id,
        sequence_id: issue.sequence_id,
        description: compactText(
          issue.description_stripped ?? issue.description_html ?? issue.description
        ),
        status: nameOf(issue.state),
        priority: issue.priority ?? "",
        labels,
        ...(repositoryHint === undefined
          ? {}
          : { repository_hint_source: repositoryHint.source })
      }
    }
  });
}

function issuePath(workspaceSlug: string, locator: PlaneIssueLocator): string {
  if (locator.kind === "project_issue") {
    return `/api/v1/workspaces/${encodeURIComponent(
      workspaceSlug
    )}/projects/${encodeURIComponent(locator.projectId)}/issues/${encodeURIComponent(
      locator.issueId
    )}`;
  }

  return `/api/v1/workspaces/${encodeURIComponent(
    workspaceSlug
  )}/work-items/${encodeURIComponent(locator.workItemKey)}/`;
}

function issueLabel(locator: PlaneIssueLocator): string {
  return locator.kind === "project_issue" ? locator.issueId : locator.workItemKey;
}

function payloadLocator(locator: PlaneIssueLocator): Record<string, string | number> {
  if (locator.kind === "project_issue") {
    return { project_id: locator.projectId };
  }

  return {
    project_identifier: locator.projectIdentifier,
    issue_identifier: locator.issueIdentifier
  };
}

export const planeTaskUrlAdapter: InputAdapter = {
  id: "plane-task-url",
  description: "Load a Plane issue from a configured Plane task URL.",
  async load(input, context) {
    return await loadPlaneTaskUrlInvocation(input, context);
  }
};
