import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  loadPiOAuthApiKey,
  registerConfiguredPiOAuthProviders,
  registeredPiProviderApiKey,
  registerPiOAuthProvider
} from "../../src/agent-runtimes/pi/auth.js";

describe("Pi OAuth auth.json integration", () => {
  it("loads and refreshes an OAuth token from auth.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-"));
    const authPath = path.join(root, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "expired",
          refresh: "refresh-token",
          expires: Date.now() - 1000
        }
      })
    );
    const getOAuthApiKey = vi.fn(async () => ({
      apiKey: "fresh-access-token",
      newCredentials: {
        type: "oauth",
        access: "fresh-access-token",
        refresh: "new-refresh-token",
        expires: Date.now() + 3600000
      }
    }));

    await expect(
      loadPiOAuthApiKey("openai-codex", { authPath, getOAuthApiKey })
    ).resolves.toBe("fresh-access-token");

    expect(getOAuthApiKey).toHaveBeenCalledWith("openai-codex", {
      "openai-codex": expect.objectContaining({
        access: "expired"
      })
    });
    await expect(readFile(authPath, "utf8")).resolves.toContain(
      "fresh-access-token"
    );
  });

  it("throws pi_auth_missing when auth.json does not contain the provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-missing-"));
    const authPath = path.join(root, "auth.json");
    await writeFile(authPath, "{}");

    await expect(
      loadPiOAuthApiKey("openai-codex", {
        authPath,
        getOAuthApiKey: vi.fn(async () => null)
      })
    ).rejects.toThrow(expect.objectContaining({ code: "pi_auth_missing" }));
  });

  it("loads Pi OAuth credentials from LUNA_AUTH_ROOT/pi-ai/auth.json by default", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-root-"));
    const authRoot = path.join(projectRoot, ".luna", "auth");
    const authPath = path.join(authRoot, "pi-ai", "auth.json");
    await mkdir(path.dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "expired",
          refresh: "refresh-token",
          expires: Date.now() - 1000
        }
      })
    );
    const getOAuthApiKey = vi.fn(async () => ({
      apiKey: "fresh-access-token",
      newCredentials: {
        type: "oauth",
        access: "fresh-access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600000
      }
    }));

    await expect(
      loadPiOAuthApiKey("openai-codex", {
        env: { LUNA_AUTH_ROOT: authRoot },
        getOAuthApiKey
      })
    ).resolves.toBe("fresh-access-token");
  });

  it("stores resolved OAuth API keys when no custom register hook is provided", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-default-register-"));
    const authPath = path.join(root, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "test-provider": {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600000
        }
      })
    );

    await registerPiOAuthProvider("test-provider", {
      authPath,
      getOAuthApiKey: vi.fn(async () => ({
        apiKey: "stored-access-token",
        newCredentials: {
          type: "oauth",
          access: "stored-access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600000
        }
      }))
    });

    expect(registeredPiProviderApiKey("test-provider")).toBe("stored-access-token");
  });

  it("registers OpenAI Codex only when resolved model profiles use it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-config-"));
    await writeFile(
      path.join(root, "models.yaml"),
      [
        "model_profiles:",
        "  default:",
        "    model: ${DEFAULT_MODEL:-openai-codex/gpt-5.4-mini}",
        "    reasoning_effort: medium",
        "  deep:",
        "    model: ${DEEP_MODEL:-openai/gpt-5}",
        "    reasoning_effort: high",
        ""
      ].join("\n")
    );
    const registerPiOAuthProvider = vi.fn(async () => {});

    await registerConfiguredPiOAuthProviders({
      configRoot: root,
      env: {},
      registerPiOAuthProvider
    });

    expect(registerPiOAuthProvider).toHaveBeenCalledTimes(1);
    expect(registerPiOAuthProvider).toHaveBeenCalledWith("openai-codex", {
      projectRoot: expect.any(String),
      env: {}
    });
  });

  it("does not register OpenAI Codex when model profiles are overridden away", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-config-skip-"));
    await writeFile(
      path.join(root, "models.yaml"),
      [
        "model_profiles:",
        "  default:",
        "    model: ${DEFAULT_MODEL:-openai-codex/gpt-5.4-mini}",
        "    reasoning_effort: medium",
        ""
      ].join("\n")
    );
    const registerPiOAuthProvider = vi.fn(async () => {});

    await registerConfiguredPiOAuthProviders({
      configRoot: root,
      env: { DEFAULT_MODEL: "openai/gpt-5" },
      registerPiOAuthProvider
    });

    expect(registerPiOAuthProvider).not.toHaveBeenCalled();
  });
});
