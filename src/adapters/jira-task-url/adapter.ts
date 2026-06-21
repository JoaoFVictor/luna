import path from "node:path";
import { z } from "zod";
import { loadYamlFile } from "../../core/config-loader.js";
import {
  jiraAuthForInstance,
  loadLunaAuth,
  type JiraAuth
} from "../../core/providers/jira/auth.js";
import {
  JiraConfigSchema,
  type JiraConfig
} from "../../core/providers/jira/config.js";
import {
  InvocationSchema,
  type Invocation
} from "../../core/types.js";
import type { AdapterInput, InputAdapter } from "../types.js";

type JiraInstanceConfig = JiraConfig["instances"][number];

export type JiraIssueRequest = {
  instance: JiraInstanceConfig;
  auth: JiraAuth;
  issueKey: string;
  fetch: typeof fetch;
};

export type JiraAdapterError = Error & {
  code:
    | "invalid_jira_issue_url"
    | "jira_instance_not_configured"
    | "jira_issue_fetch_failed"
    | "jira_issue_invalid_response"
    | "jira_repository_field_missing"
    | "jira_repository_field_invalid";
  cause?: unknown;
};

const JiraIssueSchema = z
  .object({
    key: z.string().min(1),
    fields: z.record(z.unknown())
  })
  .passthrough();

function adapterError(
  code: JiraAdapterError["code"],
  message: string,
  cause?: unknown
): JiraAdapterError {
  const error = new Error(message, { cause }) as JiraAdapterError;
  error.code = code;
  error.cause = cause;

  return error;
}

function parseJiraIssueUrl(url: string): {
  parsed: URL;
  issueKey: string;
  canonicalUrl: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw adapterError("invalid_jira_issue_url", `Invalid Jira task URL: ${url}`, cause);
  }

  if (parsed.protocol !== "https:") {
    throw adapterError("invalid_jira_issue_url", `Expected HTTPS Jira task URL: ${url}`);
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw adapterError(
      "invalid_jira_issue_url",
      "Jira task URL must not include credentials"
    );
  }

  const [browse, issueKey, ...extra] = parsed.pathname.split("/").filter(Boolean);
  if (
    browse !== "browse" ||
    issueKey === undefined ||
    extra.length > 0 ||
    !/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)
  ) {
    throw adapterError("invalid_jira_issue_url", `Expected Jira browse URL: ${url}`);
  }

  return {
    parsed,
    issueKey,
    canonicalUrl: `${parsed.origin}/browse/${issueKey}`
  };
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function findJiraInstance(jira: JiraConfig, url: URL): JiraInstanceConfig {
  const instance = jira.instances.find(
    (candidate) => originOf(candidate.base_url) === url.origin
  );

  if (instance === undefined) {
    throw adapterError(
      "jira_instance_not_configured",
      `Jira instance is not configured for origin: ${url.origin}`
    );
  }

  return instance;
}

function textFromAdf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromAdf).filter(Boolean).join(" ");
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ownText = typeof record.text === "string" ? record.text : "";
    const contentText = textFromAdf(record.content);
    const combined = `${ownText}${contentText ? ` ${contentText}` : ""}`;

    return combined.trim();
  }

  return "";
}

function compactText(value: unknown): string {
  return textFromAdf(value).replace(/\s+/g, " ").trim();
}

function fieldName(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") {
      return record.name;
    }
  }

  return compactText(value);
}

function parseGithubFullName(value: unknown): { owner: string; name: string } {
  const fullName = compactText(value);
  if (fullName.length === 0) {
    throw adapterError(
      "jira_repository_field_missing",
      "Jira repository field is missing"
    );
  }

  const [owner, name, ...extra] = fullName.split("/");
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (
    owner === undefined ||
    name === undefined ||
    extra.length > 0 ||
    !safeSegment.test(owner) ||
    !safeSegment.test(name)
  ) {
    throw adapterError(
      "jira_repository_field_invalid",
      "Expected Jira repository field to be github_full_name"
    );
  }

  return { owner, name };
}

async function defaultFetchIssue({
  instance,
  auth,
  issueKey,
  fetch
}: JiraIssueRequest): Promise<unknown> {
  const url = new URL(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    instance.base_url
  );
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(
        `${auth.email}:${auth.api_token}`,
        "utf8"
      ).toString("base64")}`
    }
  });

  if (!response.ok) {
    throw adapterError(
      "jira_issue_fetch_failed",
      `Failed to fetch Jira issue ${issueKey}: HTTP ${response.status}`
    );
  }

  return await response.json();
}

async function loadJiraIssueUrlInvocation(
  input: AdapterInput,
  context: Parameters<InputAdapter["load"]>[1]
): Promise<Invocation> {
  const { parsed, issueKey, canonicalUrl } = parseJiraIssueUrl(input.value);
  const jira = await loadYamlFile(
    path.join(context.configRoot, "jira.yaml"),
    JiraConfigSchema
  );
  const instance = findJiraInstance(jira, parsed);
  const auth = jiraAuthForInstance(await loadLunaAuth(context.projectRoot), instance.id);
  const issueResponse = await defaultFetchIssue({
    instance,
    auth,
    issueKey,
    fetch: context.fetch
  });
  const parsedIssue = JiraIssueSchema.safeParse(issueResponse);

  if (!parsedIssue.success) {
    throw adapterError(
      "jira_issue_invalid_response",
      parsedIssue.error.message,
      parsedIssue.error
    );
  }

  const issue = parsedIssue.data;
  const fields = issue.fields;
  const repositoryField = fields[instance.repository_field.field_id];
  const { owner, name } = parseGithubFullName(repositoryField);
  const summary = compactText(fields.summary);

  return InvocationSchema.parse({
    version: "2026-06",
    source: "jira",
    event: "issue",
    action: "selected",
    repository: {
      provider: "github",
      owner,
      name
    },
    subject: {
      type: "jira_issue",
      id: issue.key,
      url: canonicalUrl,
      title: summary
    },
    payload: {
      jira: {
        instance_id: instance.id,
        description: compactText(fields.description),
        acceptance_criteria: compactText(
          instance.acceptance_criteria_field === undefined
            ? ""
            : fields[instance.acceptance_criteria_field.field_id]
        ),
        status: fieldName(fields.status),
        issue_type: fieldName(fields.issuetype)
      }
    }
  });
}

export const jiraTaskUrlAdapter: InputAdapter = {
  id: "jira-task-url",
  description: "Load a Jira issue from a configured Jira browse URL.",
  async load(input, context) {
    return await loadJiraIssueUrlInvocation(input, context);
  }
};
