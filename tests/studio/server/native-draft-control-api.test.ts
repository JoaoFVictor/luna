import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createNativeStudioServices } from "../../../src/studio/server/native-services.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";
import { createStudioServer } from "../../../src/studio/server/studio-server.js";

const HOST = "127.0.0.1:43110";
const ORIGIN = `http://${HOST}`;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function controlApiFixture() {
  const projectRoot = await temporaryDirectory("luna-studio-http-project-");
  const configRoot = await temporaryDirectory("luna-studio-http-config-");
  await Promise.all([
    mkdir(path.join(projectRoot, "workflows")),
    mkdir(path.join(projectRoot, "agents"))
  ]);
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
  const server = await createStudioServer({
    sessions,
    services,
    logger: false
  });
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
  if (exchanged.statusCode !== 200) {
    await server.close();
    throw new Error("Studio session capability exchange failed");
  }
  const setCookie = exchanged.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(
    ";",
    1
  )[0];
  if (cookie === undefined) {
    await server.close();
    throw new Error("Studio session exchange did not return a cookie");
  }
  const csrf = exchanged.json<{ csrf_token: string }>().csrf_token;
  return {
    projectRoot,
    configRoot,
    server,
    mutationHeaders: {
      host: HOST,
      origin: ORIGIN,
      cookie,
      "x-luna-csrf": csrf,
      "content-type": "application/json"
    }
  };
}

describe("native Studio draft Control API", () => {
  it("executes blank draft through compile, plan, and atomic apply", async () => {
    const { projectRoot, server, mutationHeaders } =
      await controlApiFixture();

    const created = await server.inject({
      method: "POST",
      url: "/api/studio/v1/drafts",
      headers: mutationHeaders,
      payload: {
        resource: { kind: "workflow", id: "http-flow" },
        source: { mode: "blank" }
      }
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ draft_id: string; etag: string }>();
    expect(created.headers.etag).toBe(draft.etag);

    const compiled = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draft.draft_id}/compile`,
      headers: { ...mutationHeaders, "if-match": draft.etag },
      payload: {}
    });
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json()).toMatchObject({
      draft: { status: "valid" },
      validation: { status: "valid", compiled: true }
    });
    const compiledEtag = compiled.headers.etag;
    if (typeof compiledEtag !== "string") {
      throw new Error("Studio compile did not return an ETag");
    }

    const planned = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draft.draft_id}/plan-apply`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(planned.statusCode).toBe(200);
    const plan = planned.json<{ plan_token: string }>();
    expect(plan.plan_token).toBeTypeOf("string");

    const applied = await server.inject({
      method: "POST",
      url: `/api/studio/v1/drafts/${draft.draft_id}/apply`,
      headers: { ...mutationHeaders, "if-match": compiledEtag },
      payload: {
        plan_token: plan.plan_token,
        idempotency_key: "http-apply-http-flow"
      }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ status: "committed" });
    await expect(
      readFile(
        path.join(projectRoot, "workflows", "http-flow", "workflow.yaml"),
        "utf8"
      )
    ).resolves.toContain("id: http-flow");

    await server.close();
  });

  it("refuses agent apply when its pinned model profile disappears after planning", async () => {
    const { projectRoot, configRoot, server, mutationHeaders } =
      await controlApiFixture();
    const modelsPath = path.join(configRoot, "models.yaml");
    await writeFile(
      modelsPath,
      [
        "model_profiles:",
        "  fast:",
        "    model: test/test-model",
        "    reasoning_effort: low",
        ""
      ].join("\n"),
      "utf8"
    );
    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/studio/v1/drafts",
        headers: mutationHeaders,
        payload: {
          resource: { kind: "agent", id: "profile-bound-agent" },
          source: { mode: "blank", model_profile: "fast" }
        }
      });
      expect(created.statusCode).toBe(201);
      const draft = created.json<{ draft_id: string; etag: string }>();

      const compiled = await server.inject({
        method: "POST",
        url: `/api/studio/v1/drafts/${draft.draft_id}/compile`,
        headers: { ...mutationHeaders, "if-match": draft.etag },
        payload: {}
      });
      expect(compiled.statusCode).toBe(200);
      const compiledEtag = compiled.headers.etag;
      if (typeof compiledEtag !== "string") {
        throw new Error("Studio compile did not return an ETag");
      }

      const planned = await server.inject({
        method: "POST",
        url: `/api/studio/v1/drafts/${draft.draft_id}/plan-apply`,
        headers: mutationHeaders,
        payload: {}
      });
      expect(planned.statusCode).toBe(200);
      const plan = planned.json<{ plan_token: string }>();
      await rm(modelsPath);

      const applied = await server.inject({
        method: "POST",
        url: `/api/studio/v1/drafts/${draft.draft_id}/apply`,
        headers: { ...mutationHeaders, "if-match": compiledEtag },
        payload: {
          plan_token: plan.plan_token,
          idempotency_key: "http-apply-profile-bound-agent"
        }
      });
      expect(applied.statusCode).toBe(409);
      expect(applied.json()).toMatchObject({
        error: { code: "studio_apply_source_conflict" }
      });
      await expect(readFile(
        path.join(
          projectRoot,
          "agents",
          "profile-bound-agent",
          "agent.yaml"
        ),
        "utf8"
      )).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });
});
