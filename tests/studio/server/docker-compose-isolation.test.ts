import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ComposeMount = string | {
  readonly type?: string;
  readonly source?: string;
  readonly target?: string;
  readonly read_only?: boolean;
  readonly bind?: { readonly create_host_path?: boolean };
};

type ComposeDocument = {
  readonly name?: string;
  readonly "x-luna-image"?: { readonly user?: string };
  readonly services?: Record<string, {
    readonly command?: readonly string[];
    readonly environment?: Record<string, string>;
    readonly volumes?: readonly ComposeMount[];
  }>;
};

async function composeSource(): Promise<string> {
  return await readFile(path.resolve("docker-compose.yml"), "utf8");
}

describe("Docker Compose checkout isolation", () => {
  it("uses the checkout identity for both project and Studio state namespaces", async () => {
    const document = parse(await composeSource()) as ComposeDocument;

    expect(document.name).toContain("LUNA_STUDIO_CHECKOUT_ID");
    expect(document.services?.studio?.environment).toMatchObject({
      LUNA_STUDIO_CHECKOUT_ID: expect.stringContaining("LUNA_STUDIO_CHECKOUT_ID"),
      LUNA_STUDIO_CONTAINER_MODE: "1",
      LUNA_STUDIO_STATE_ROOT: "/var/lib/luna-studio"
    });
  });

  it("runs Luna as the host identity and never recursively owns a bind mount", async () => {
    const source = await composeSource();
    const dockerfile = await readFile(path.resolve("Dockerfile"), "utf8");
    const document = parse(source) as ComposeDocument;
    const initializer = document.services?.["studio-state-permissions"];

    expect(document["x-luna-image"]?.user).toContain("HOST_UID");
    expect(document["x-luna-image"]?.user).toContain("HOST_GID");
    expect(source).not.toMatch(/chown\s+-R/u);
    expect(dockerfile).not.toMatch(/chown\s+-R/u);
    expect(initializer?.volumes?.filter((mount) =>
      typeof mount === "string" || mount.read_only !== true)).toEqual([
      "luna-studio-state:/var/lib/luna-studio"
    ]);
    expect(initializer?.volumes?.filter((mount) =>
      typeof mount !== "string").every((mount) => mount.read_only)).toBe(true);
  });

  it("requires pre-existing host state directories instead of root-created binds", async () => {
    const document = parse(await composeSource()) as ComposeDocument;
    const studioMounts = document.services?.studio?.volumes ?? [];
    const required = new Map(
      studioMounts
        .filter((mount): mount is Exclude<ComposeMount, string> =>
          typeof mount !== "string")
        .map((mount) => [mount.target, mount])
    );

    expect(required.get("/app/.runs")?.bind?.create_host_path).toBe(false);
    expect(required.get("/app/.luna/studio")?.bind?.create_host_path).toBe(false);
  });

  it("does not shadow image-built application artifacts with host dist mounts", async () => {
    const source = await composeSource();
    const override = await readFile(path.resolve("docker-compose.override.yml"), "utf8");

    expect(source).not.toContain("/app/dist");
    expect(override).not.toContain("/app/apps/studio/dist");
  });
});
