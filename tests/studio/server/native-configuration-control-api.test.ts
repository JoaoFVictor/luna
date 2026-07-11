import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createNativeStudioServices } from "../../../src/studio/server/native-services.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";
import { createStudioServer } from "../../../src/studio/server/studio-server.js";

const HOST = "127.0.0.1:43110";
const ORIGIN = `http://${HOST}`;
const PRIVATE_CANARY = "CONFIG_PRIVATE_CANARY_475a";
const OUTSIDE_CANARY = "OUTSIDE_CONFIG_CANARY_f4ce";
const temporaryDirectories: string[] = [];

const WORKFLOW = [
  "id: review",
  "type: workflow",
  "mode: read_only",
  "input_schema: input.schema.json",
  "output_schema: output.schema.json",
  "config:",
  "  file: review.yaml",
  "  schema: config.schema.json",
  "capabilities: []",
  "nodes: []",
  ""
].join("\n");

const CONFIGURATION = [
  "settings:",
  "  # This private-source comment must survive structured edits.",
  "  enabled: false",
  "  label: stable",
  `  hidden: ${PRIVATE_CANARY}`,
  `  token: ${PRIVATE_CANARY}`,
  ""
].join("\n");

const CONFIGURATION_SCHEMA = JSON.stringify(
  {
    type: "object",
    additionalProperties: false,
    required: ["settings"],
    properties: {
      settings: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "label", "hidden", "token"],
        properties: {
          enabled: {
            type: "boolean",
            title: "Enabled",
            "x-luna-studio": { exposure: "editable" }
          },
          label: {
            type: "string",
            title: "Label",
            "x-luna-studio": { exposure: "read_only" }
          },
          hidden: { type: "string" },
          token: {
            type: "string",
            writeOnly: true,
            "x-luna-studio": { exposure: "editable" }
          }
        }
      }
    }
  },
  null,
  2
);

type StudioSessionHeaders = {
  readonly read: {
    readonly host: string;
    readonly origin: string;
    readonly cookie: string;
  };
  readonly mutation: {
    readonly host: string;
    readonly origin: string;
    readonly cookie: string;
    readonly "x-luna-csrf": string;
    readonly "content-type": "application/json";
  };
};

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfigurationFixture(
  projectRoot: string,
  configRoot: string
): Promise<void> {
  const workflowRoot = path.join(projectRoot, "workflows", "review");
  await Promise.all([
    mkdir(workflowRoot, { recursive: true }),
    mkdir(path.join(projectRoot, "agents"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(workflowRoot, "workflow.yaml"), WORKFLOW, "utf8"),
    writeFile(
      path.join(workflowRoot, "input.schema.json"),
      '{"type":"object","additionalProperties":false}\n',
      "utf8"
    ),
    writeFile(
      path.join(workflowRoot, "output.schema.json"),
      '{"type":"object","additionalProperties":false}\n',
      "utf8"
    ),
    writeFile(
      path.join(workflowRoot, "config.schema.json"),
      `${CONFIGURATION_SCHEMA}\n`,
      "utf8"
    ),
    writeFile(path.join(configRoot, "review.yaml"), CONFIGURATION, "utf8")
  ]);
}

async function createNativeServer(
  projectRoot: string,
  configRoot: string
): Promise<{
  readonly server: FastifyInstance;
  readonly capability: string;
}> {
  const services = await createNativeStudioServices({
    projectRoot,
    configRoot,
    stateRoot: path.join(configRoot, ".test-studio-state"),
    app: {
      workspace: {
        strategy: "git_worktree",
        root: ".worktrees",
        preserve_on_success: true,
        preserve_on_failure: true
      },
      artifacts: { root: ".runs" }
    },
    platform: nativeLunaPlatformRegistrations
  });
  const sessions = new StudioLocalSessionManager({
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN]
  });
  const capability = sessions.bootstrapCapability();
  return {
    server: await createStudioServer({ sessions, services, logger: false }),
    capability
  };
}

async function exchangeSession(
  server: FastifyInstance,
  capability: string
): Promise<StudioSessionHeaders> {
  const exchanged = await server.inject({
    method: "POST",
    url: "/api/studio/v1/session/exchange",
    headers: {
      host: HOST,
      origin: ORIGIN,
      "content-type": "application/json"
    },
    payload: { capability }
  });
  expect(exchanged.statusCode).toBe(200);
  const setCookie = exchanged.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(
    ";",
    1
  )[0];
  if (cookie === undefined) {
    throw new Error("Studio session exchange did not return a cookie");
  }
  const csrf = exchanged.json<{ csrf_token: string }>().csrf_token;
  return {
    read: { host: HOST, origin: ORIGIN, cookie },
    mutation: {
      host: HOST,
      origin: ORIGIN,
      cookie,
      "x-luna-csrf": csrf,
      "content-type": "application/json"
    }
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("native Studio configuration Control API", () => {
  it("keeps private YAML server-side through CSRF, CAS, apply, and restart", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-config-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-root-");
    await writeConfigurationFixture(projectRoot, configRoot);
    const native = await createNativeServer(projectRoot, configRoot);
    const { server } = native;
    const headers = await exchangeSession(server, native.capability);
    const workflowUrl = "/api/studio/v1/configuration/workflows/review";
    const draftsUrl = `${workflowUrl}/drafts`;

    const configuration = await server.inject({
      method: "GET",
      url: workflowUrl,
      headers: headers.read
    });
    expect(configuration.statusCode).toBe(200);
    expect(configuration.json()).toMatchObject({
      workflow_id: "review",
      raw_yaml_enabled: false,
      fields: [
        { path: ["settings", "enabled"], exposure: "editable", value: false },
        { path: ["settings", "label"], exposure: "read_only", value: "stable" }
      ]
    });
    expect(configuration.body).not.toContain(PRIVATE_CANARY);

    const csrfRejected = await server.inject({
      method: "POST",
      url: draftsUrl,
      headers: {
        ...headers.read,
        "content-type": "application/json"
      },
      payload: {}
    });
    expect(csrfRejected.statusCode).toBe(403);

    const created = await server.inject({
      method: "POST",
      url: draftsUrl,
      headers: headers.mutation,
      payload: {}
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(PRIVATE_CANARY);
    const draft = created.json<{ draft_id: string; etag: string }>();
    expect(created.headers.etag).toBe(draft.etag);

    const genericProjection = await server.inject({
      method: "GET",
      url: `/api/studio/v1/drafts/${draft.draft_id}`,
      headers: headers.read
    });
    expect(genericProjection.statusCode).toBe(404);
    expect(genericProjection.body).not.toContain(PRIVATE_CANARY);

    const patched = await server.inject({
      method: "PATCH",
      url: `${draftsUrl}/${draft.draft_id}`,
      headers: { ...headers.mutation, "if-match": draft.etag },
      payload: {
        updates: [{ path: ["settings", "enabled"], value: true }]
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.body).not.toContain(PRIVATE_CANARY);
    const patchedDraft = patched.json<{ etag: string }>();
    expect(patchedDraft.etag).not.toBe(draft.etag);
    expect(patched.headers.etag).toBe(patchedDraft.etag);

    const stalePatch = await server.inject({
      method: "PATCH",
      url: `${draftsUrl}/${draft.draft_id}`,
      headers: { ...headers.mutation, "if-match": draft.etag },
      payload: {
        updates: [{ path: ["settings", "enabled"], value: false }]
      }
    });
    expect(stalePatch.statusCode).toBe(412);
    expect(stalePatch.body).not.toContain(PRIVATE_CANARY);

    const validated = await server.inject({
      method: "POST",
      url: `${draftsUrl}/${draft.draft_id}/validate`,
      headers: { ...headers.mutation, "if-match": patchedDraft.etag },
      payload: {}
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.body).not.toContain(PRIVATE_CANARY);
    const validatedDraft = validated.json<{
      draft: { etag: string; status: string };
    }>().draft;
    expect(validatedDraft.status).toBe("valid");
    expect(validated.headers.etag).toBe(validatedDraft.etag);

    const planned = await server.inject({
      method: "POST",
      url: `${draftsUrl}/${draft.draft_id}/plan-apply`,
      headers: headers.mutation,
      payload: {}
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.body).not.toContain(PRIVATE_CANARY);
    expect(planned.body).not.toContain("textual_diff");
    const plan = planned.json<{
      status: string;
      plan_token: string;
      changes: unknown[];
    }>();
    expect(plan).toMatchObject({
      status: "ready",
      changes: [
        {
          path: ["settings", "enabled"],
          before: false,
          after: true
        }
      ]
    });

    const applied = await server.inject({
      method: "POST",
      url: `${draftsUrl}/${draft.draft_id}/apply`,
      headers: { ...headers.mutation, "if-match": validatedDraft.etag },
      payload: {
        plan_token: plan.plan_token,
        idempotency_key: "configuration-review-apply"
      }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ status: "committed" });
    expect(applied.body).not.toContain(PRIVATE_CANARY);
    expect(applied.body).not.toContain("textual_diff");

    const persisted = await readFile(path.join(configRoot, "review.yaml"), "utf8");
    expect(persisted).toContain(
      "# This private-source comment must survive structured edits."
    );
    expect(persisted).toContain("enabled: true");
    expect(persisted).toContain(PRIVATE_CANARY);
    await server.close();

    const restartedNative = await createNativeServer(projectRoot, configRoot);
    const restartedHeaders = await exchangeSession(
      restartedNative.server,
      restartedNative.capability
    );
    const recovered = await restartedNative.server.inject({
      method: "GET",
      url: `${draftsUrl}/${draft.draft_id}`,
      headers: restartedHeaders.read
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      draft_id: draft.draft_id,
      configuration: {
        workflow_id: "review",
        raw_yaml_enabled: false
      }
    });
    expect(recovered.body).not.toContain(PRIVATE_CANARY);
    await restartedNative.server.close();
  });

  it("rejects a symlinked configuration source without disclosing its target", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-config-project-");
    const configRoot = await temporaryDirectory("luna-studio-config-root-");
    const outsideRoot = await temporaryDirectory("luna-studio-config-outside-");
    await writeConfigurationFixture(projectRoot, configRoot);
    const outsidePath = path.join(outsideRoot, "private.yaml");
    const configurationPath = path.join(configRoot, "review.yaml");
    await writeFile(outsidePath, `secret: ${OUTSIDE_CANARY}\n`, "utf8");
    await rm(configurationPath);
    await symlink(outsidePath, configurationPath);

    const native = await createNativeServer(projectRoot, configRoot);
    const { server } = native;
    const headers = await exchangeSession(server, native.capability);
    const response = await server.inject({
      method: "GET",
      url: "/api/studio/v1/configuration/workflows/review",
      headers: headers.read
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "studio_configuration_source_invalid" }
    });
    expect(response.body).not.toContain(OUTSIDE_CANARY);
    expect(response.body).not.toContain(outsidePath);
    await server.close();
  });
});
