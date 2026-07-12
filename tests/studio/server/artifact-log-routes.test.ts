import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ArtifactReaderPort } from "../../../src/studio/application/artifacts/ports.js";
import { artifactReaderError } from "../../../src/studio/application/artifacts/errors.js";
import type { RunLogReaderPort } from "../../../src/studio/application/runs/log-ports.js";
import type { RunCatalogPort } from "../../../src/studio/application/runs/ports.js";
import {
  registerStudioControlApi,
  type StudioControlApiOptions
} from "../../../src/studio/server/control-api.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";

const HOST = "127.0.0.1:43110";
const ORIGIN = `http://${HOST}`;
const RUN_ID = "run-artifacts-1";
const HANDLE = `ah_${"a".repeat(43)}`;
const CREATED_AT = "2026-07-10T12:00:00.000Z";

const catalog = {
  get: async (runId: string) =>
    runId === RUN_ID ? ({} as Awaited<ReturnType<RunCatalogPort["get"]>>) : undefined
} satisfies Pick<RunCatalogPort, "get">;

const metadata = {
  manifest_handle: HANDLE,
  name: "unsafe\"\r\nX-Injected: yes",
  attempt: 1,
  media_type: "text/plain",
  semantic_type: "luna.review.findings.v1",
  status: "committed",
  created_at: CREATED_AT,
  preview_capability: "probe_required",
  content_length: 5,
  downloadable: true,
  raw_download_redaction: "not_applied"
} as const;

const artifactReader: ArtifactReaderPort = {
  async list(runId) {
    return {
      run_id: runId,
      items: [
        {
          manifest_handle: HANDLE,
          name: metadata.name,
          attempt: 1,
          media_type: "text/plain",
          semantic_type: metadata.semantic_type,
          status: "committed",
          created_at: CREATED_AT,
          preview_capability: "probe_required"
        }
      ],
      redaction: "best_effort_on_preview"
    };
  },
  async metadata() {
    return metadata;
  },
  async preview() {
    return {
      kind: "text",
      metadata,
      inspected_bytes: 5,
      truncated: false,
      integrity: "not_declared",
      encoding: "utf-8",
      text: "safe",
      redaction: { mode: "best_effort", changed: true },
      render_policy: "plain_text_only"
    };
  },
  async openDownload() {
    return {
      metadata,
      body: (async function* () {
        yield Buffer.from("raw!!", "utf8");
      })(),
      disposition: "attachment",
      redaction: "not_applied"
    };
  }
};

const runLogs: RunLogReaderPort = {
  async list(query) {
    return {
      run_id: query.run_id,
      items: [
        {
          sequence: 1,
          timestamp: CREATED_AT,
          level: "warn",
          message: "Authorization: Bearer [REDACTED]",
          redaction: "best_effort"
        }
      ],
      next_cursor: null,
      as_of: CREATED_AT,
      snapshot_bytes: 64,
      scanned_bytes: 64,
      redaction: "best_effort"
    };
  }
};

function minimalServices(
  sessions: StudioLocalSessionManager,
  artifacts: ArtifactReaderPort = artifactReader
): StudioControlApiOptions {
  return {
    sessions,
    queries: {
      capabilities: () => ({
        technical_fingerprint: `sha256:${"1".repeat(64)}`,
        presentation_fingerprint: `sha256:${"2".repeat(64)}`,
        capabilities: [],
        registrations: []
      }),
      agents: () => ({
        status: "complete",
        fingerprint: `sha256:${"3".repeat(64)}`,
        agents: [],
        diagnostics: []
      }),
      workflows: () => ({
        status: "complete",
        fingerprint: `sha256:${"4".repeat(64)}`,
        workflows: [],
        diagnostics: []
      })
    },
    inputRouting: {
      listInputAdapters: () => ({ adapters: [] }),
      previewInputAdapter: async () => {
        throw new Error("not used");
      },
      previewInputRoute: async () => {
        throw new Error("not used");
      },
      routingDefinition: () => ({
        type: "router",
        version: "2026-06",
        rules: []
      }),
      simulateRouting: async () => ({
        status: "no_match",
        target: null,
        matched_rule: null,
        evaluations: [],
        diagnostics: []
      })
    },
    artifacts: { reader: artifacts, catalog },
    runLogs: { reader: runLogs, catalog }
  };
}

async function fixture(artifacts: ArtifactReaderPort = artifactReader) {
  const sessions = new StudioLocalSessionManager({
    allowedHosts: [HOST],
    allowedOrigins: [ORIGIN]
  });
  const server = Fastify({ logger: false });
  await registerStudioControlApi(server, minimalServices(sessions, artifacts));
  await server.ready();
  const capability = sessions.bootstrapCapability();
  const exchange = await server.inject({
    method: "POST",
    url: "/api/studio/v1/session/exchange",
    headers: {
      host: HOST,
      origin: ORIGIN,
      "content-type": "application/json"
    },
    payload: { capability }
  });
  return { server, cookie: exchange.headers["set-cookie"] };
}

describe("Studio artifact and run log routes", () => {
  it("serves opaque artifact projections, safe preview, and forced attachment", async () => {
    const { server, cookie } = await fixture();
    const headers = { host: HOST, cookie };
    const list = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/artifacts`,
      headers
    });
    const preview = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/artifacts/${HANDLE}/preview`,
      headers
    });
    const download = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/artifacts/${HANDLE}/download`,
      headers
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ semantic_type: "luna.review.findings.v1" }]
    });
    expect(list.body).not.toContain("artifact_path");
    expect(list.body).not.toContain("backend_root");
    expect(preview.json()).toMatchObject({
      kind: "text",
      text: "safe",
      metadata: { semantic_type: "luna.review.findings.v1" },
      redaction: { changed: true }
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("raw!!");
    expect(download.headers["content-type"]).toContain("application/octet-stream");
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(download.headers["content-disposition"]).toContain("%0D%0A");
    expect(download.headers["x-injected"]).toBeUndefined();
    await server.close();
  });

  it("validates log filters and returns only redacted public entries", async () => {
    const { server, cookie } = await fixture();
    const response = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/logs?levels=warn,error&limit=100`,
      headers: { host: HOST, cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      run_id: RUN_ID,
      items: [
        {
          message: "Authorization: Bearer [REDACTED]",
          redaction: "best_effort"
        }
      ]
    });
    const invalidCursor = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/logs?cursor=x`,
      headers: { host: HOST, cookie }
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({
      error: { code: "run_log_input_invalid" }
    });
    await server.close();
  });

  it("maps reader failures without exposing internal causes", async () => {
    const secret = "private-artifact-path";
    const failing = {
      ...artifactReader,
      async list(): Promise<never> {
        throw artifactReaderError("artifact_io_failed", `failed at ${secret}`);
      }
    };
    const { server, cookie } = await fixture(failing);
    const response = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/artifacts`,
      headers: { host: HOST, cookie }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: "artifact_io_failed",
        message: "The artifact could not be read"
      }
    });
    expect(response.body).not.toContain(secret);
    await server.close();
  });

  it("requires an authenticated local session and a known run", async () => {
    const { server, cookie } = await fixture();
    const unauthenticated = await server.inject({
      method: "GET",
      url: `/api/studio/v1/runs/${RUN_ID}/artifacts`,
      headers: { host: HOST }
    });
    const missing = await server.inject({
      method: "GET",
      url: "/api/studio/v1/runs/missing/artifacts",
      headers: { host: HOST, cookie }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "run_not_found" } });
    await server.close();
  });
});
