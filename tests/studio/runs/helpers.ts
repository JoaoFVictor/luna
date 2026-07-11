import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createSqliteRunStore,
  type SqliteRunStore
} from "../../../src/studio/adapters/sqlite/run-store.js";
import type { PreallocateRunInput } from "../../../src/studio/application/runs/ports.js";

export const DIGEST_A = `sha256:${"a".repeat(64)}`;
export const DIGEST_B = `sha256:${"b".repeat(64)}`;
export const DIGEST_C = `sha256:${"c".repeat(64)}`;
export const DIGEST_D = `sha256:${"d".repeat(64)}`;

export function preallocation(
  runId: string,
  overrides: Partial<PreallocateRunInput> = {}
): PreallocateRunInput {
  return {
    transition_id: `allocate-${runId}`,
    event_id: `event-allocate-${runId}`,
    run_id: runId,
    correlation_id: `correlation-${runId}`,
    job_id: `job-${runId}`,
    workflow_id: "code-review",
    definition: {
      workflow_revision: DIGEST_A,
      definition_bundle_hash: DIGEST_B,
      catalog_fingerprint: DIGEST_C,
      execution_snapshot_hash: DIGEST_D
    },
    created_at: "2026-07-10T12:00:00.000Z",
    source: "github",
    repository_id: "repository-1",
    graph_snapshot_handle: `gs_${"A".repeat(22)}`,
    ...overrides
  };
}

export async function withRunStore(
  operation: (context: {
    root: string;
    filePath: string;
    store: SqliteRunStore;
  }) => Promise<void>,
  options: { now?: () => Date } = {}
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "luna-studio-runs-"));
  const filePath = path.join(root, "runs.sqlite");
  const store = await createSqliteRunStore({
    filePath,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  try {
    await operation({ root, filePath, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
