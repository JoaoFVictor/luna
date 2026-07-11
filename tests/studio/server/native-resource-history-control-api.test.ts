import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import { createNativeStudioServices } from "../../../src/studio/server/native-services.js";
import { StudioLocalSessionManager } from "../../../src/studio/server/security/local-session.js";
import { createStudioServer } from "../../../src/studio/server/studio-server.js";

const execFileAsync = promisify(execFile);
const HOST = "127.0.0.1:43110";
const ORIGIN = `http://${HOST}`;
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

function agentYaml(description: string): string {
  return [
    "id: reviewer",
    `description: ${description}`,
    "model_profile: fast",
    "mode: read_only",
    "instructions_file: instructions.md",
    "output_schema: output.schema.json",
    ""
  ].join("\n");
}

async function installAgent(
  projectRoot: string,
  description: string,
  instructions: string
): Promise<void> {
  const directory = path.join(projectRoot, "agents", "reviewer");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "agent.yaml"), agentYaml(description), "utf8"),
    writeFile(path.join(directory, "instructions.md"), instructions, "utf8"),
    writeFile(
      path.join(directory, "output.schema.json"),
      '{"type":"object","additionalProperties":false}\n',
      "utf8"
    )
  ]);
}

async function commit(projectRoot: string, subject: string): Promise<string> {
  await git(projectRoot, ["add", "-A", "--"]);
  await git(projectRoot, [
    "-c",
    "user.name=Private Test Author",
    "-c",
    "user.email=private-author@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-m",
    subject
  ]);
  return await git(projectRoot, ["rev-parse", "HEAD"]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("native Studio resource history Control API", () => {
  it("lists, compares, and restores a Git revision only as a new draft", async () => {
    const projectRoot = await temporaryDirectory("luna-studio-history-http-");
    const stateRoot = await temporaryDirectory("luna-studio-history-state-");
    const configRoot = path.join(projectRoot, "config");
    await Promise.all([
      mkdir(configRoot),
      mkdir(path.join(projectRoot, "workflows")),
      mkdir(path.join(projectRoot, "agents"))
    ]);
    await git(projectRoot, ["init", "-b", "main"]);
    await installAgent(
      projectRoot,
      "Historical reviewer",
      "Historical instructions\n"
    );
    const historicalRevision = await commit(projectRoot, "Create reviewer");
    await installAgent(
      projectRoot,
      "Current reviewer",
      "Current instructions\n"
    );
    const currentRevision = await commit(projectRoot, "Update reviewer");

    const services = await createNativeStudioServices({
      projectRoot,
      configRoot,
      stateRoot,
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
      payload: { capability: sessions.bootstrapCapability() }
    });
    const setCookie = exchanged.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(
      ";",
      1
    )[0];
    if (cookie === undefined) {
      throw new Error("Studio session exchange did not return a cookie");
    }
    const csrf = exchanged.json<{ csrf_token: string }>().csrf_token;
    const readHeaders = { host: HOST, origin: ORIGIN, cookie };
    const mutationHeaders = {
      ...readHeaders,
      "x-luna-csrf": csrf,
      "content-type": "application/json"
    };
    const base = "/api/studio/v1/resources/agent/reviewer/history";

    const listed = await server.inject({
      method: "GET",
      url: `${base}?limit=10`,
      headers: readHeaders
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      resource: { kind: "agent", id: "reviewer" },
      revisions: [
        { revision_id: currentRevision, subject: "Update reviewer" },
        { revision_id: historicalRevision, subject: "Create reviewer" }
      ]
    });
    expect(JSON.stringify(listed.json())).not.toContain(
      "private-author@example.invalid"
    );

    const compared = await server.inject({
      method: "GET",
      url:
        `${base}/compare?base_revision_id=${historicalRevision}` +
        `&target_revision_id=${currentRevision}`,
      headers: readHeaders
    });
    expect(compared.statusCode).toBe(200);
    expect(compared.json()).toMatchObject({
      base_revision_id: historicalRevision,
      target_revision_id: currentRevision
    });
    expect(compared.json<{ diff: unknown[] }>().diff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: { root: "project", path: "agents/reviewer/agent.yaml" },
          kind: "modified",
          redacted: true
        })
      ])
    );

    const restored = await server.inject({
      method: "POST",
      url: `${base}/restore`,
      headers: mutationHeaders,
      payload: {
        revision_id: historicalRevision,
        confirm_restore_as_new_draft: true
      }
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.headers.location).toMatch(/^\/api\/studio\/v1\/drafts\//u);
    expect(restored.json()).toMatchObject({
      resource: { kind: "agent", id: "reviewer" },
      revision_id: historicalRevision,
      draft: {
        primary_resource: { kind: "agent", id: "reviewer" },
        status: "dirty"
      }
    });
    expect(
      restored.json<{
        draft: {
          files: ReadonlyArray<{
            file: { root: string; path: string };
            state: string;
            content?: string;
          }>;
        };
      }>().draft.files
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: { root: "project", path: "agents/reviewer/agent.yaml" },
          state: "present",
          content: expect.stringContaining("Historical reviewer")
        })
      ])
    );
    await expect(
      readFile(path.join(projectRoot, "agents", "reviewer", "agent.yaml"), "utf8")
    ).resolves.toContain("Current reviewer");
    await expect(git(projectRoot, ["rev-parse", "HEAD"]))
      .resolves.toBe(currentRevision);

    await server.close();
  });
});
