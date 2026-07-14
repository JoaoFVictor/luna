import { chmod, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGit } from "../../../src/capabilities/git/client.js";
import {
  clearRepositoryIndexCache,
  repositoryIndex,
  RepositoryIndexCapacityError,
  repositoryIndexCacheStats,
  repositoryIndexResourcePolicy
} from "../../../src/capabilities/repository-context/repository-index.js";

async function write(root: string, filePath: string, content: string): Promise<void> {
  const absolute = path.join(root, filePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

describe("canonical repository index", () => {
  it("indexes the complete Git inventory without a prefix scan limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-complete-"));
    await runGit(root, ["init", "--quiet"]);

    try {
      await Promise.all(Array.from({ length: 725 }, (_, index) =>
        write(root, `src/modules/module-${String(index).padStart(3, "0")}.ts`, `export const module${index} = ${index};\n`)
      ));
      const result = await repositoryIndex({ root });

      expect(result.coverage).toMatchObject({
        inventory_files: 725,
        eligible_files: 725,
        indexed_files: 725,
        complete: true
      });
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes unfamiliar text generically and classifies binary files without extension gates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-generic-text-"));
    await runGit(root, ["init", "--quiet"]);

    try {
      await Promise.all([
        write(root, "src/main.swift", "struct Checkout { let id: String }\n"),
        write(root, "src/main.dart", "class Checkout { final String id = ''; }\n"),
        write(root, "src/Main.scala", "object Checkout { val id = \"\" }\n"),
        write(root, "lib/main.ex", "defmodule Checkout do\nend\n"),
        write(root, "src/main.zig", "pub const Checkout = struct {};\n"),
        write(root, "infra/main.tf", "resource \"null_resource\" \"checkout\" {}\n"),
        write(root, "Dockerfile", "FROM scratch\n"),
        write(root, "BUILD.custom", "checkout_rule(name = \"checkout\")\n")
      ]);
      await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
      await writeFile(path.join(root, "module.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
      await symlink("src/main.swift", path.join(root, "source.link"));
      await runGit(root, ["add", "."]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "generic languages"
      ]);

      const result = await repositoryIndex({ root });

      expect(result.coverage).toMatchObject({
        inventory_files: 11,
        eligible_files: 8,
        indexed_files: 8,
        excluded_files: 3,
        binary_excluded_files: 2,
        non_regular_excluded_files: 1,
        generic_text_files: 1,
        unavailable_files: 0,
        complete: true
      });
      expect(result.coverage.languages).toEqual(expect.arrayContaining([
        "dart",
        "dockerfile",
        "elixir",
        "hcl",
        "scala",
        "swift",
        "zig"
      ]));
      expect(result.candidates.map((candidate) => candidate.path)).toContain("BUILD.custom");
      expect(result.candidates.map((candidate) => candidate.path)).not.toContain("logo.png");
      expect(result.candidates.map((candidate) => candidate.path)).not.toContain("module.wasm");
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("single-flights 50 same-root requests before snapshot discovery and invalidates changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-cache-"));
    await runGit(root, ["init", "--quiet"]);
    clearRepositoryIndexCache();

    try {
      await write(root, "src/service.ts", "export const service = 1;\n");
      await runGit(root, ["add", "src/service.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "baseline"
      ]);
      const leaderController = new AbortController();
      const leader = repositoryIndex({ root, signal: leaderController.signal });
      const followers = Array.from({ length: 49 }, () => repositoryIndex({ root }));
      leaderController.abort();
      const leaderFailure = await leader.catch((cause: unknown) => cause);
      const concurrent = await Promise.all(followers);
      const first = concurrent[0]!;

      expect((leaderFailure as Error).name).toBe("AbortError");
      expect(concurrent.every((index) => index === first)).toBe(true);
      expect(repositoryIndexCacheStats()).toMatchObject({
        builds: 1,
        initial_snapshots: 1,
        root_flight_hits: 49,
        entries: 1,
        active_operations: 0,
        queued_operations: 0
      });
      expect(repositoryIndexCacheStats().bytes).toBeGreaterThan(0);
      expect(first.snapshot.dirty).toBe(false);
      const warm = await repositoryIndex({ root });
      expect(warm).toBe(first);
      expect(repositoryIndexCacheStats()).toMatchObject({
        builds: 1,
        hits: 1,
        snapshot_fingerprinted_bytes: 0
      });

      await write(root, "src/service.ts", "export const service = 3;\n");
      await runGit(root, ["add", "src/service.ts"]);
      await write(root, "src/service.ts", "export const service = 2;\n");
      const changed = await repositoryIndex({ root });

      expect(changed.snapshot.dirty).toBe(true);
      expect(changed.snapshot.id).not.toBe(first.snapshot.id);
      expect(repositoryIndexCacheStats().builds).toBe(2);

      await write(root, "src/service.ts", "export const service = 4;\n");
      await runGit(root, ["add", "src/service.ts"]);
      await write(root, "src/service.ts", "export const service = 2;\n");
      const restaged = await repositoryIndex({ root });

      expect(restaged.snapshot.id).not.toBe(changed.snapshot.id);
      expect(repositoryIndexCacheStats().builds).toBe(3);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads clean tracked bytes from Git objects so ABA worktree content never enters the index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-aba-"));
    await runGit(root, ["init", "--quiet"]);
    clearRepositoryIndexCache();

    try {
      const baseline = "export const value = 'baseline';\n";
      await write(root, "src/value.ts", baseline);
      await runGit(root, ["add", "src/value.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "baseline"
      ]);

      const pending = repositoryIndex({ root });
      while (repositoryIndexCacheStats().active_builds === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await write(root, "src/value.ts", "export const secret = 'transient';\n");
      await write(root, "src/value.ts", baseline);
      const result = await pending;

      expect(result.candidates.find((candidate) => candidate.path === "src/value.ts")?.content)
        .toBe(baseline);
      expect(result.candidates.every((candidate) => !candidate.content.includes("transient")))
        .toBe(true);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores mutable Git replace refs when reading canonical blob bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-replace-"));
    await runGit(root, ["init", "--quiet"]);
    clearRepositoryIndexCache();

    try {
      const baseline = "export const value = 'canonical';\n";
      await write(root, "src/value.ts", baseline);
      await runGit(root, ["add", "src/value.ts"]);
      await write(root, "replacement.ts", "export const value = 'replaced';\n");
      const indexEntry = (await runGit(root, ["ls-files", "-s", "--", "src/value.ts"])).trim();
      const canonicalOid = indexEntry.split(/\s+/u)[1]!;
      const replacementOid = (await runGit(root, ["hash-object", "-w", "replacement.ts"])).trim();
      await runGit(root, ["replace", canonicalOid, replacementOid]);

      const indexed = await repositoryIndex({ root });
      expect(indexed.candidates.find((candidate) => candidate.path === "src/value.ts")?.content)
        .toBe(baseline);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds fingerprints to raw bytes so UTF-8 BOM files index without false conflicts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-bom-"));
    await runGit(root, ["init", "--quiet"]);
    clearRepositoryIndexCache();

    try {
      const file = path.join(root, "src", "bom.ts");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("export const bom = true;\n")
      ]));
      await runGit(root, ["add", "src/bom.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "bom"
      ]);

      const result = await repositoryIndex({ root });

      expect(result.coverage.complete).toBe(true);
      expect(result.candidates[0]?.content).toBe("export const bom = true;\n");
      expect(repositoryIndexCacheStats().snapshot_conflicts).toBe(0);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects pre-aborted and queued callers without orphaning work or cache entries", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "luna-repository-index-cancel-"));
    const roots = ["one", "two", "queued"].map((name) => path.join(parent, name));
    clearRepositoryIndexCache();

    try {
      const preAborted = new AbortController();
      preAborted.abort();
      const preFailure = await repositoryIndex({
        root: roots[0]!,
        signal: preAborted.signal
      }).catch((cause: unknown) => cause);
      expect((preFailure as Error).name).toBe("AbortError");
      expect(repositoryIndexCacheStats()).toMatchObject({
        active_operations: 0,
        root_flights: 0,
        entries: 0
      });

      await Promise.all(roots.map(async (root, index) => {
        await mkdir(root, { recursive: true });
        await runGit(root, ["init", "--quiet"]);
        await write(root, "src/service.ts", `export const value = ${index};\n`);
      }));
      const first = repositoryIndex({ root: roots[0]! });
      const second = repositoryIndex({ root: roots[1]! });
      const queuedController = new AbortController();
      const queued = repositoryIndex({ root: roots[2]!, signal: queuedController.signal });
      expect(repositoryIndexCacheStats().queued_operations).toBe(1);
      queuedController.abort();

      const queuedFailure = await queued.catch((cause: unknown) => cause);
      expect((queuedFailure as Error).name).toBe("AbortError");
      await Promise.all([first, second]);
      expect(repositoryIndexCacheStats()).toMatchObject({
        active_operations: 0,
        queued_operations: 0,
        root_flights: 0,
        entries: 1,
        cache_evictions_for_admission: 1
      });
    } finally {
      clearRepositoryIndexCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("aborts the shared operation and never caches when every consumer detaches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-cancel-all-"));
    await runGit(root, ["init", "--quiet"]);
    clearRepositoryIndexCache();

    try {
      await Promise.all(Array.from({ length: 250 }, (_, index) =>
        write(root, `src/file-${index}.ts`, `export const value${index} = ${index};\n`)
      ));
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = repositoryIndex({ root, signal: firstController.signal });
      const second = repositoryIndex({ root, signal: secondController.signal });
      firstController.abort();
      secondController.abort();

      const results = await Promise.allSettled([first, second]);
      expect(results.every((result) => result.status === "rejected" &&
        (result.reason as Error).name === "AbortError")).toBe(true);
      while (repositoryIndexCacheStats().root_flights > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(repositoryIndexCacheStats()).toMatchObject({
        entries: 0,
        bytes: 0,
        active_operations: 0,
        queued_operations: 0,
        root_flights: 0
      });
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds global discovery/build admission and cleans the queue after overflow", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "luna-repository-index-admission-"));
    const policy = repositoryIndexResourcePolicy();
    const rootCount = policy.max_concurrent_index_operations +
      policy.max_queued_index_operations + 1;
    const roots = Array.from({ length: rootCount }, (_, index) =>
      path.join(parent, `repository-${index}`)
    );
    clearRepositoryIndexCache();

    try {
      await Promise.all(roots.map(async (root, index) => {
        await mkdir(root, { recursive: true });
        await runGit(root, ["init", "--quiet"]);
        await write(root, "src/service.ts", `export const service = ${index};\n`);
      }));

      const results = await Promise.allSettled(roots.map((root) => repositoryIndex({ root })));
      const rejected = results.filter((result) => result.status === "rejected");
      const fulfilled = results.filter((result) => result.status === "fulfilled");

      expect(fulfilled).toHaveLength(rootCount - 1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason)
        .toBeInstanceOf(RepositoryIndexCapacityError);
      expect(((rejected[0] as PromiseRejectedResult).reason as RepositoryIndexCapacityError)
        .diagnostics).toEqual({
          phase: "admission",
          resource: "queued_operations",
          observed: policy.max_queued_index_operations + 1,
          limit: policy.max_queued_index_operations
        });
      expect(repositoryIndexCacheStats()).toMatchObject({
        admission_rejections: 1,
        capacity_rejections: 1,
        active_operations: 0,
        queued_operations: 0,
        root_flights: 0
      });
      expect(repositoryIndexCacheStats().peak_active_operations)
        .toBeLessThanOrEqual(policy.max_concurrent_index_operations);
      expect(repositoryIndexCacheStats().peak_queued_operations)
        .toBe(policy.max_queued_index_operations);
      expect(repositoryIndexCacheStats().peak_reserved_bytes)
        .toBeLessThanOrEqual(policy.max_process_index_bytes);
      expect(repositoryIndexCacheStats().peak_process_accounted_bytes)
        .toBeLessThanOrEqual(policy.max_process_index_bytes);
      expect(repositoryIndexCacheStats().process_accounted_bytes)
        .toBe(repositoryIndexCacheStats().bytes);
    } finally {
      clearRepositoryIndexCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("retries once instead of caching content under a stale snapshot identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-snapshot-race-"));
    await runGit(root, ["init", "--quiet"]);
    clearRepositoryIndexCache();

    try {
      await write(root, "src/service.ts", "export const service = 'before';\n");
      await runGit(root, ["add", "src/service.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "baseline"
      ]);

      const pending = repositoryIndex({ root });
      while (repositoryIndexCacheStats().active_builds === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await write(root, "src/service.ts", "export const service = 'after';\n");
      const result = await pending;

      expect(result.candidates.find((candidate) => candidate.path === "src/service.ts")?.content)
        .toBe("export const service = 'after';\n");
      expect(repositoryIndexCacheStats()).toMatchObject({
        builds: 2,
        failed_builds: 1,
        snapshot_conflicts: 1,
        snapshot_retries: 1,
        entries: 1
      });
      const cached = await repositoryIndex({ root });
      expect(cached.snapshot.id).toBe(result.snapshot.id);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes agent-tool metadata by path segment while retaining normal repository configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-policy-"));
    await runGit(root, ["init", "--quiet"]);

    try {
      await Promise.all([
        write(root, ".agents/internal.ts", "export const instruction = true;\n"),
        write(root, ".claude/skills/review.md", "hidden instructions\n"),
        write(root, "src/.codex/prompt.md", "hidden prompt\n"),
        write(root, "packages/app/.cursor/rules.md", "hidden rules\n"),
        write(root, "AGENTS.md", "agent instructions\n"),
        write(root, "docs/CLAUDE.md", "assistant instructions\n"),
        write(root, ".github/copilot-instructions.md", "copilot instructions\n"),
        write(root, ".env", "SECRET_MUST_NOT_BE_READ=true\n"),
        write(root, ".github/workflows/ci.yaml", "name: ci\n"),
        write(root, "public/offline.html", "<main>Offline</main>\n"),
        write(root, "assets/site.css", "main { display: block; }\n")
      ]);

      await Promise.all([
        chmod(path.join(root, ".claude/skills/review.md"), 0),
        chmod(path.join(root, "AGENTS.md"), 0),
        chmod(path.join(root, ".env"), 0)
      ]);
      const result = await repositoryIndex({ root: path.relative(process.cwd(), root) });

      expect(result.coverage).toMatchObject({
        inventory_files: 11,
        eligible_files: 3,
        indexed_files: 3,
        excluded_files: 8,
        policy_excluded_files: 8,
        unavailable_files: 0,
        complete: true
      });
      expect(result.candidates.map((candidate) => candidate.path)).toEqual([
        ".github/workflows/ci.yaml",
        "assets/site.css",
        "public/offline.html"
      ]);
      expect(result.coverage.languages).toEqual(expect.arrayContaining(["css", "html", "yaml"]));
      expect(result.stats.peak_inflight_source_bytes)
        .toBeLessThanOrEqual(result.stats.limits.max_inflight_source_bytes);
      expect(result.stats.read_concurrency).toBeGreaterThan(0);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before content reads when one eligible file exceeds the byte policy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-file-budget-"));
    await runGit(root, ["init", "--quiet"]);
    const policy = repositoryIndexResourcePolicy();

    try {
      const oversized = path.join(root, "src", "oversized.ts");
      await mkdir(path.dirname(oversized), { recursive: true });
      await writeFile(oversized, "x".repeat(64 * 1024), "utf8");
      await truncate(oversized, policy.max_file_source_bytes + 1);
      await runGit(root, ["add", "src/oversized.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "oversized text"
      ]);

      const failure = await repositoryIndex({ root }).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(RepositoryIndexCapacityError);
      expect((failure as RepositoryIndexCapacityError).diagnostics).toEqual({
        phase: "preflight",
        resource: "file_source_bytes",
        observed: policy.max_file_source_bytes + 1,
        limit: policy.max_file_source_bytes,
        path: "src/oversized.ts"
      });
      expect(repositoryIndexCacheStats()).toMatchObject({
        failed_builds: 1,
        capacity_rejections: 1,
        active_builds: 0,
        entries: 0
      });
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies oversized tracked and untracked binaries without failing the index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-large-binary-"));
    await runGit(root, ["init", "--quiet"]);
    const policy = repositoryIndexResourcePolicy();

    try {
      for (const name of ["tracked.bin", "untracked.bin"]) {
        const file = path.join(root, "assets", name);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.from([0, 1, 2, 3]));
        await truncate(file, policy.max_file_source_bytes + 1024);
      }
      await runGit(root, ["add", "assets/tracked.bin"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "large binary"
      ]);

      const result = await repositoryIndex({ root });

      expect(result.coverage).toMatchObject({
        inventory_files: 2,
        eligible_files: 0,
        indexed_files: 0,
        binary_excluded_files: 2,
        complete: true
      });
      expect(result.candidates).toEqual([]);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes case-variant credential paths, configured globs, and detected secret material", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-secrets-"));
    await runGit(root, ["init", "--quiet"]);

    try {
      await Promise.all([
        write(root, ".Codex/prompt.md", "malicious instructions\n"),
        write(root, ".AWS/Credentials", "aws_secret_access_key=secret\n"),
        write(root, "config/credentials.json", "{\"token\":\"secret\"}\n"),
        write(root, "generated/internal.txt", "operator excluded\n"),
        write(root, "src/private.txt", "-----BEGIN PRIVATE KEY-----\nnot-for-model\n"),
        write(root, "src/public.ts", "export const publicValue = true;\n")
      ]);

      const result = await repositoryIndex({
        root,
        policy: { exclude_globs: ["generated/**"] }
      });

      expect(result.coverage).toMatchObject({
        inventory_files: 6,
        eligible_files: 1,
        indexed_files: 1,
        policy_excluded_files: 4,
        sensitive_excluded_files: 1,
        complete: true
      });
      expect(result.candidates.map((candidate) => candidate.path)).toEqual(["src/public.ts"]);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on aggregate source bytes without truncating the inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-total-budget-"));
    await runGit(root, ["init", "--quiet"]);
    const policy = repositoryIndexResourcePolicy();
    const fileCount = Math.floor(policy.max_total_source_bytes / policy.max_file_source_bytes) + 1;

    try {
      await Promise.all(Array.from({ length: fileCount }, async (_, index) => {
        const file = path.join(root, "src", `part-${index}.ts`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "", "utf8");
        await truncate(file, policy.max_file_source_bytes);
      }));

      const failure = await repositoryIndex({ root }).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(RepositoryIndexCapacityError);
      expect((failure as RepositoryIndexCapacityError).diagnostics).toMatchObject({
        phase: "preflight",
        resource: "total_source_bytes",
        limit: policy.max_total_source_bytes
      });
      expect((failure as RepositoryIndexCapacityError).diagnostics.observed)
        .toBeGreaterThan(policy.max_total_source_bytes);
      expect(repositoryIndexCacheStats().capacity_rejections).toBe(1);
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies invalid UTF-8 bytes as binary instead of indexing replacement text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-repository-index-utf8-"));
    await runGit(root, ["init", "--quiet"]);

    try {
      const file = path.join(root, "public", "offline.html");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from([0xff, 0xfe, 0xfd]));

      const result = await repositoryIndex({ root });

      expect(result.coverage).toMatchObject({
        inventory_files: 1,
        eligible_files: 0,
        indexed_files: 0,
        excluded_files: 1,
        binary_excluded_files: 1,
        unavailable_files: 0,
        complete: true
      });
      expect(result.candidates).toEqual([]);
      expect(result.warnings).not.toContain(
        "Repository index is incomplete: 1 eligible files became unavailable during indexing."
      );
    } finally {
      clearRepositoryIndexCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never follows a replaced parent directory symlink outside the repository", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "luna-repository-index-symlink-"));
    const root = path.join(parent, "repository");
    const outside = path.join(parent, "outside");
    await mkdir(root, { recursive: true });
    await runGit(root, ["init", "--quiet"]);

    try {
      await write(root, "src/service.ts", "export const origin = 'repository';\n");
      await runGit(root, ["add", "src/service.ts"]);
      await runGit(root, [
        "-c", "user.name=Luna Tests",
        "-c", "user.email=luna@example.invalid",
        "commit", "--quiet", "-m", "baseline"
      ]);
      await write(outside, "service.ts", "export const secret = 'outside';\n");
      await rename(path.join(root, "src"), path.join(root, "src-original"));
      await symlink(outside, path.join(root, "src"), "dir");

      const result = await repositoryIndex({ root });

      expect(result.coverage).toMatchObject({
        eligible_files: 3,
        indexed_files: 1,
        unavailable_files: 2,
        complete: false
      });
      expect(result.candidates.map((candidate) => candidate.path))
        .toEqual(["src-original/service.ts"]);
      expect(result.candidates.every((candidate) => !candidate.content.includes("outside")))
        .toBe(true);
    } finally {
      clearRepositoryIndexCache();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
