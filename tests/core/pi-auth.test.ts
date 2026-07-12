import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Credential } from "@earendil-works/pi-ai";
import {
  createPiCredentialStore,
  createPiModels,
  piAuthPath
} from "../../src/agent-runtimes/pi/auth.js";

describe("Pi provider-neutral auth integration", () => {
  it("reads legacy OAuth credentials and persists provider refreshes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-"));
    const authPath = path.join(root, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "openai-codex": {
          access: "expired",
          refresh: "refresh-token",
          expires: Date.now() - 1000
        }
      })
    );

    const store = createPiCredentialStore({ authPath });
    await expect(store.read("openai-codex")).resolves.toMatchObject({
      type: "oauth",
      access: "expired"
    });

    await store.modify("openai-codex", async (credential) => ({
      ...credential,
      type: "oauth",
      access: "fresh-access-token",
      expires: Date.now() + 3600000
    } as Credential));

    await expect(readFile(authPath, "utf8")).resolves.toContain(
      "fresh-access-token"
    );
    await expect(store.read("openai-codex")).resolves.toMatchObject({
      type: "oauth",
      access: "fresh-access-token"
    });
  });

  it("supports API-key credentials for providers without OAuth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-api-key-"));
    const store = createPiCredentialStore({
      authPath: path.join(root, "auth.json")
    });

    await store.modify("anthropic", async () => ({
      type: "api_key",
      key: "provider-key"
    }));

    await expect(store.read("anthropic")).resolves.toEqual({
      type: "api_key",
      key: "provider-key"
    });
    await store.delete("anthropic");
    await expect(store.read("anthropic")).resolves.toBeUndefined();
  });

  it("creates a registry with providers beyond the current OpenAI setup", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-pi-models-"));
    const authRoot = path.join(projectRoot, ".luna", "auth");
    await mkdir(path.join(authRoot, "pi-ai"), { recursive: true });

    const models = createPiModels({
      projectRoot,
      env: { LUNA_AUTH_ROOT: authRoot }
    });

    expect(models.getProvider("openai-codex")).toBeDefined();
    expect(models.getProvider("anthropic")).toBeDefined();
    expect(models.getModel("openai-codex", "gpt-5.6-sol")).toBeDefined();
    expect(piAuthPath(projectRoot, { LUNA_AUTH_ROOT: authRoot })).toBe(
      path.join(authRoot, "pi-ai", "auth.json")
    );
  });
});
