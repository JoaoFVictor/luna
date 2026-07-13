import type { AnyLunaToolDefinition, LunaToolDefinition } from
  "../../core/tools/contracts.js";
import { z } from "zod";
import { queryRepositoryContext } from "./collector.js";
import type {
  RelatedContextConfig,
  RelatedContextTask,
  RepositoryContextQuery
} from "./contracts.js";
import {
  RelatedContextConfigSchema,
  RelatedContextTaskSchema
} from "./contracts.js";
import { repositoryContextQueryToolContract } from "./tool-contracts.js";
import { RepositoryContextPolicyConfigSchema } from "../../core/config/schemas.js";

type RepositoryContextQueryInput = {
  readonly query: RelatedContextTask;
  readonly config?: RelatedContextConfig;
  readonly expected_snapshot_id?: string;
};

const SnapshotIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

function boundSnapshotIds(value: unknown): {
  readonly ids: readonly string[];
  readonly truncated: boolean;
} {
  const ids = new Set<string>();
  const seen = new Set<object>();
  let visited = 0;
  let truncated = false;

  const visit = (candidate: unknown, depth: number): void => {
    if (typeof candidate !== "object" || candidate === null) {
      return;
    }
    if (depth > 24 || visited >= 20_000) {
      truncated = true;
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    visited += 1;

    if (!Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (
        (record.kind === "luna.repository_context.v2" ||
          record.kind === "luna.repository_context_query.v1") &&
        typeof record.snapshot === "object" &&
        record.snapshot !== null &&
        !Array.isArray(record.snapshot)
      ) {
        const id = (record.snapshot as Record<string, unknown>).id;
        if (typeof id === "string" && SnapshotIdSchema.safeParse(id).success) ids.add(id);
      }
    }

    for (const child of Array.isArray(candidate)
      ? candidate
      : Object.values(candidate as Record<string, unknown>)) {
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return { ids: [...ids].sort(), truncated };
}

export const repositoryContextQueryTool: LunaToolDefinition<
  RepositoryContextQueryInput,
  RepositoryContextQuery
> = {
  ...repositoryContextQueryToolContract,
  createHandler: (dependencies) => async (input) => {
    const task = RelatedContextTaskSchema.parse(input.query);
    const config = input.config === undefined
      ? undefined
      : RelatedContextConfigSchema.parse(input.config);
    const indexPolicy = dependencies.configuration === undefined
      ? undefined
      : RepositoryContextPolicyConfigSchema.parse(dependencies.configuration);
    const requestedSnapshotId = input.expected_snapshot_id === undefined
      ? undefined
      : SnapshotIdSchema.parse(input.expected_snapshot_id);
    const binding = boundSnapshotIds(dependencies.agentInput);
    if (binding.truncated) {
      throw new Error(
        "Repository context query could not safely inspect the complete agent snapshot binding."
      );
    }
    const boundIds = binding.ids;
    if (boundIds.length > 1 && requestedSnapshotId === undefined) {
      throw new Error(
        "Repository context query is bound to multiple snapshots; expected_snapshot_id is required."
      );
    }
    const boundSnapshotId = boundIds.length === 1 ? boundIds[0] : undefined;
    if (
      requestedSnapshotId !== undefined &&
      boundSnapshotId !== undefined &&
      requestedSnapshotId !== boundSnapshotId
    ) {
      throw new Error(
        "Repository context query expected_snapshot_id does not match the agent's bound snapshot."
      );
    }
    const expectedSnapshotId = requestedSnapshotId ?? boundSnapshotId;
    return await queryRepositoryContext({
      root: dependencies.cwd,
      task,
      ...(config === undefined ? {} : { config }),
      ...(indexPolicy === undefined ? {} : { indexPolicy }),
      ...(expectedSnapshotId === undefined ? {} : { expectedSnapshotId }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal })
    });
  }
};

export const repositoryContextLocalTools = {
  [repositoryContextQueryTool.id]: repositoryContextQueryTool
} satisfies Record<string, AnyLunaToolDefinition>;
