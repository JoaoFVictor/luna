import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitStudioResourceHistory } from "../../../src/studio/adapters/git/resource-history.js";
import { StudioResourceHistoryError } from "../../../src/studio/application/history/errors.js";
import {
  StudioGitRevisionIdSchema,
  StudioHistoryResourceSchema
} from "../../../src/studio/contracts/resource-history.js";

const execFileAsync = promisify(execFile);
const AUTHOR_EMAIL_CANARY = "private-author@example.invalid";
const OUTSIDE_SECRET_CANARY = "OUTSIDE_TOKEN=never-return-this";

function agentYaml(
  id: string,
  instructionsFile = "instructions.md",
  outputSchema = "output.schema.json"
): string {
  return [
    `id: ${id}`,
    "description: Historical test agent",
    "model_profile: default",
    "mode: read_only",
    `instructions_file: ${instructionsFile}`,
    `output_schema: ${outputSchema}`,
    ""
  ].join("\n");
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout.trim();
}

async function write(relativePath: string, content: string | Uint8Array): Promise<void> {
  const target = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function writeAgent(
  id: string,
  options: {
    readonly instructionsFile?: string;
    readonly instructions?: string;
    readonly outputSchema?: string;
  } = {}
): Promise<void> {
  const instructionsFile = options.instructionsFile ?? "instructions.md";
  await write(`agents/${id}/agent.yaml`, agentYaml(id, instructionsFile));
  await write(
    `agents/${id}/${instructionsFile}`,
    options.instructions ?? `Instructions for ${id}\n`
  );
  await write(
    `agents/${id}/output.schema.json`,
    options.outputSchema ?? '{"type":"object"}\n'
  );
}

async function commit(subject: string): Promise<string> {
  await git(repositoryRoot, ["add", "-A", "--"]);
  await git(repositoryRoot, [
    "-c",
    "user.name=Private Author",
    "-c",
    `user.email=${AUTHOR_EMAIL_CANARY}`,
    "commit",
    "--no-gpg-sign",
    "-m",
    subject
  ]);
  return await git(repositoryRoot, ["rev-parse", "HEAD"]);
}

let repositoryRoot: string;

beforeEach(async () => {
  repositoryRoot = await mkdtemp(path.join(tmpdir(), "luna-studio-history-"));
  await git(repositoryRoot, ["init", "-b", "main"]);
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("GitStudioResourceHistory", () => {
  it("lists only path-scoped current-branch history with bounded public metadata", async () => {
    await write("outside.env", `${OUTSIDE_SECRET_CANARY}\n`);
    await commit("outside-only change");
    await writeAgent("reviewer");
    const longSubject = `entity ${"x".repeat(300)}`;
    const entityRevision = await commit(longSubject);
    await write("unrelated.txt", "unrelated\n");
    await commit("another outside-only change");

    const history = new GitStudioResourceHistory({
      projectRoot: repositoryRoot
    });
    const page = await history.list(
      { kind: "agent", id: "reviewer" },
      { limit: 10 }
    );

    expect(page).toEqual({
      revisions: [
        expect.objectContaining({
          revision_id: entityRevision,
          subject: expect.stringMatching(/^entity x+$/u)
        })
      ],
      truncated: false
    });
    expect(page.revisions[0]?.subject.length).toBe(240);
    expect(page.revisions[0]?.committed_at).toMatch(/Z$/u);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(AUTHOR_EMAIL_CANARY);
    expect(serialized).not.toContain("outside.env");
    expect(serialized).not.toContain(OUTSIDE_SECRET_CANARY);
  });

  it("never follows a rename outside the current entity path", async () => {
    await writeAgent("old-name");
    await commit("create old agent");
    await git(repositoryRoot, ["mv", "--", "agents/old-name", "agents/new-name"]);
    await write("agents/new-name/agent.yaml", agentYaml("new-name"));
    const renameRevision = await commit("rename old agent");

    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });
    const page = await history.list(
      { kind: "agent", id: "new-name" },
      { limit: 10 }
    );

    expect(page.revisions.map((revision) => revision.revision_id)).toEqual([
      renameRevision
    ]);
    expect(JSON.stringify(page)).not.toContain("old-name");
  });

  it("loads a reachable revision for a resource deleted from current source", async () => {
    await writeAgent("deleted-agent");
    const presentRevision = await commit("create deletable agent");
    await rm(path.join(repositoryRoot, "agents/deleted-agent"), {
      recursive: true
    });
    const deletedRevision = await commit("delete agent");

    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });
    const page = await history.list(
      { kind: "agent", id: "deleted-agent" },
      { limit: 10 }
    );
    expect(page.revisions).toHaveLength(2);

    const snapshot = await history.snapshot(
      { kind: "agent", id: "deleted-agent" },
      presentRevision
    );
    expect(snapshot.files.map((file) => file.file.path)).toEqual([
      "agents/deleted-agent/agent.yaml",
      "agents/deleted-agent/instructions.md",
      "agents/deleted-agent/output.schema.json"
    ]);
    await expect(
      history.snapshot(
        { kind: "agent", id: "deleted-agent" },
        deletedRevision
      )
    ).rejects.toMatchObject({
      code: "studio_history_resource_not_found"
    });
  });

  it("rejects a selected historical symlink without reading its target", async () => {
    await write("outside-secret.txt", OUTSIDE_SECRET_CANARY);
    await write("agents/linked/agent.yaml", agentYaml("linked"));
    await mkdir(path.join(repositoryRoot, "agents/linked"), { recursive: true });
    await symlink(
      "../../outside-secret.txt",
      path.join(repositoryRoot, "agents/linked/instructions.md")
    );
    await write("agents/linked/output.schema.json", '{"type":"object"}\n');
    const revision = await commit("add linked agent");

    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });
    await expect(
      history.snapshot({ kind: "agent", id: "linked" }, revision)
    ).rejects.toMatchObject({ code: "studio_history_resource_invalid" });
  });

  it("rejects a selected historical submodule entry", async () => {
    await write("seed.txt", "seed\n");
    const seedCommit = await commit("seed commit");
    await write("agents/gitlink/agent.yaml", agentYaml("gitlink"));
    await write("agents/gitlink/output.schema.json", '{"type":"object"}\n');
    await git(repositoryRoot, ["add", "--", "agents/gitlink/agent.yaml"]);
    await git(repositoryRoot, ["add", "--", "agents/gitlink/output.schema.json"]);
    await git(repositoryRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${seedCommit},agents/gitlink/instructions.md`
    ]);
    await git(repositoryRoot, [
      "-c",
      "user.name=Private Author",
      "-c",
      `user.email=${AUTHOR_EMAIL_CANARY}`,
      "commit",
      "--no-gpg-sign",
      "-m",
      "add gitlink agent"
    ]);
    const revision = await git(repositoryRoot, ["rev-parse", "HEAD"]);

    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });
    await expect(
      history.snapshot({ kind: "agent", id: "gitlink" }, revision)
    ).rejects.toMatchObject({ code: "studio_history_resource_invalid" });
  });

  it("rejects an oversized referenced blob before returning content", async () => {
    await writeAgent("huge", {
      outputSchema: `{"description":"${"x".repeat(2 * 1024 * 1024)}"}\n`
    });
    const revision = await commit("add huge schema");
    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });

    await expect(
      history.snapshot({ kind: "agent", id: "huge" }, revision)
    ).rejects.toMatchObject({ code: "studio_history_source_too_large" });
  });

  it("rejects credential-sensitive entity references", async () => {
    await write("agents/unsafe/agent.yaml", agentYaml("unsafe", ".env"));
    await write("agents/unsafe/.env", OUTSIDE_SECRET_CANARY);
    await write("agents/unsafe/output.schema.json", '{"type":"object"}\n');
    const revision = await commit("add unsafe agent");
    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });

    await expect(
      history.snapshot({ kind: "agent", id: "unsafe" }, revision)
    ).rejects.toMatchObject({ code: "studio_history_resource_invalid" });
  });

  it("rejects commits that are not reachable from the current branch", async () => {
    await writeAgent("main-agent");
    await commit("main base");
    await git(repositoryRoot, ["checkout", "-b", "side"]);
    await writeAgent("side-agent");
    const sideRevision = await commit("side-only agent");
    await git(repositoryRoot, ["checkout", "main"]);

    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });
    await expect(
      history.snapshot({ kind: "agent", id: "side-agent" }, sideRevision)
    ).rejects.toMatchObject({
      code: "studio_history_revision_not_reachable"
    });
  });

  it("rejects detached HEAD and never accepts path/revspec injection", async () => {
    await writeAgent("safe-agent");
    const revision = await commit("safe agent");
    await git(repositoryRoot, ["checkout", "--detach", revision]);
    const history = new GitStudioResourceHistory({ projectRoot: repositoryRoot });

    await expect(
      history.list({ kind: "agent", id: "safe-agent" }, { limit: 10 })
    ).rejects.toMatchObject({ code: "studio_history_unavailable" });
    expect(
      StudioHistoryResourceSchema.safeParse({
        kind: "agent",
        id: "--all ../../outside"
      }).success
    ).toBe(false);
    expect(StudioGitRevisionIdSchema.safeParse("HEAD~1 --all").success).toBe(
      false
    );
  });

  it("does not leak raw Git diagnostics", async () => {
    const history = new GitStudioResourceHistory({
      projectRoot: path.join(repositoryRoot, "missing")
    });
    let caught: unknown;
    try {
      await history.list({ kind: "agent", id: "safe" }, { limit: 10 });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(StudioResourceHistoryError);
    expect(JSON.stringify(caught)).not.toContain(repositoryRoot);
    expect((caught as Error).message).not.toContain(repositoryRoot);
  });
});
