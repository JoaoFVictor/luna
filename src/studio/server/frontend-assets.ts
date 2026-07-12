import { access } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const FRONTEND_ENTRY_FILE = "index.html";
const ASSET_PREFIX = "/assets/";
const CONTROL_API_PREFIX = "/api/studio/v1";
const PUBLIC_ASSET_PATHS = new Set(["/favicon.svg", "/icons.svg"]);

export type StudioFrontendAssetsOptions = {
  readonly root: string;
};

export class StudioFrontendAssetsError extends Error {
  readonly code = "studio_frontend_assets_invalid" as const;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "StudioFrontendAssetsError";
  }
}

export function defaultStudioFrontendRoot(projectRoot: string): string {
  return path.resolve(projectRoot, "apps", "studio", "dist");
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function isControlPlanePath(value: string): boolean {
  return (
    value === CONTROL_API_PREFIX ||
    value.startsWith(`${CONTROL_API_PREFIX}/`) ||
    value === "/health" ||
    value === ASSET_PREFIX.slice(0, -1) ||
    value.startsWith(ASSET_PREFIX) ||
    PUBLIC_ASSET_PATHS.has(value)
  );
}

async function sendFrontendEntry(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  if (isControlPlanePath(requestPath(request))) {
    reply.callNotFound();
    return reply;
  }
  return await reply.sendFile(FRONTEND_ENTRY_FILE, {
    cacheControl: false,
    immutable: false,
    maxAge: 0
  });
}

async function assertFrontendBuild(root: string): Promise<void> {
  try {
    await Promise.all([
      access(path.join(root, FRONTEND_ENTRY_FILE)),
      access(path.join(root, "assets"))
    ]);
  } catch (cause) {
    throw new StudioFrontendAssetsError(
      "Luna Studio frontend build is missing; run npm run studio:build",
      { cause }
    );
  }
}

export async function registerStudioFrontendAssets(
  server: FastifyInstance,
  options: StudioFrontendAssetsOptions
): Promise<void> {
  const root = path.resolve(options.root);
  await assertFrontendBuild(root);
  await server.register(fastifyStatic, {
    root,
    serve: false,
    serveDotFiles: false
  });
  await server.register(fastifyStatic, {
    root: path.join(root, "assets"),
    prefix: ASSET_PREFIX,
    decorateReply: false,
    immutable: true,
    maxAge: "30d",
    index: false,
    redirect: false,
    serveDotFiles: false
  });
  server.get("/", sendFrontendEntry);
  for (const assetPath of PUBLIC_ASSET_PATHS) {
    server.get(assetPath, async (_request, reply) =>
      await reply.sendFile(assetPath.slice(1), {
        immutable: true,
        maxAge: "30d"
      })
    );
  }
  server.get("/*", sendFrontendEntry);
}
