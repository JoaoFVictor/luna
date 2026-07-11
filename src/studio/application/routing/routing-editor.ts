import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AppConfig } from "../../../core/config/schemas.js";
import { RouterDefinitionSchema } from "../../../core/router/router-definition.js";
import { resolvePathInsideRoot } from "../../../core/security/path.js";
import { sha256Digest } from "../../../core/workflow/definition-digests.js";
import type { StudioDraftLockPort } from "../drafts/persistence.js";
import {
  StudioRoutingEditorSchema,
  StudioRoutingSaveResultSchema,
  type StudioRoutingEditor,
  type StudioRoutingSaveRequest,
  type StudioRoutingSaveResult
} from "../../contracts/input-routing.js";

type RoutingLoader = () => Promise<unknown>;

function routingRevision(definition: unknown): string {
  return sha256Digest(RouterDefinitionSchema.parse(definition));
}

function projectEditor(definition: unknown): StudioRoutingEditor {
  const parsed = RouterDefinitionSchema.parse(definition);
  return StudioRoutingEditorSchema.parse({
    definition: parsed,
    revision: routingRevision(parsed),
    editing: "cas"
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class StudioRoutingEditorService {
  readonly #configRoot: string;
  readonly #routingPath: string;
  readonly #load: RoutingLoader;
  readonly #locks: StudioDraftLockPort;

  constructor(options: {
    readonly configRoot: string;
    readonly app?: AppConfig;
    readonly load: RoutingLoader;
    readonly locks: StudioDraftLockPort;
  }) {
    this.#configRoot = path.resolve(options.configRoot);
    this.#routingPath = options.app?.routing?.path ?? "routing.yaml";
    this.#load = options.load;
    this.#locks = options.locks;
  }

  async get(): Promise<StudioRoutingEditor> {
    return projectEditor(await this.#load());
  }

  async save(request: StudioRoutingSaveRequest): Promise<StudioRoutingSaveResult> {
    const definition = RouterDefinitionSchema.parse(request.definition);
    const release = await this.#locks.acquire("studio-routing-definition", "exclusive");
    try {
      const current = await this.get();
      if (current.revision !== request.expected_revision) {
        return StudioRoutingSaveResultSchema.parse({
          status: "conflict",
          current
        });
      }
      const target = await resolvePathInsideRoot(
        this.#configRoot,
        this.#routingPath.split("/")
      );
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Routing definition must be a regular non-symlink file");
      }
      const directory = path.dirname(target);
      if ((await realpath(directory)) !== directory) {
        throw new Error("Routing definition directory must be physically resolved");
      }
      const temporary = path.join(
        directory,
        `.routing.${randomBytes(12).toString("hex")}.tmp`
      );
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        metadata.mode & 0o777
      );
      let committed = false;
      try {
        try {
          await handle.writeFile(YAML.stringify(definition), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
        committed = true;
        await syncDirectory(directory);
      } finally {
        if (!committed) await rm(temporary, { force: true });
      }
      return StudioRoutingSaveResultSchema.parse({
        status: "saved",
        editor: projectEditor(definition)
      });
    } finally {
      await release();
    }
  }
}
