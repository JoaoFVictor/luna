import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  loadPiOAuthApiKey,
  registerConfiguredPiOAuthProviders,
  registerPiOAuthProvider
} from "../../src/core/agent-runtime/flue/pi-auth.js";

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

  it("registers the provider with the resolved OAuth access token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "luna-pi-auth-register-"));
    const authPath = path.join(root, "auth.json");
    await mkdir(root, { recursive: true });
    await writeFile(
      authPath,
      JSON.stringify({
        "openai-codex": {
        type: "oauth",
        access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600000
        }
      })
    );
    const registerProvider = vi.fn();

    await registerPiOAuthProvider("openai-codex", {
      authPath,
      registerProvider,
      getOAuthApiKey: vi.fn(async () => ({
        apiKey: "access-token",
        newCredentials: {
        type: "oauth",
        access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600000
        }
      }))
    });

    expect(registerProvider).toHaveBeenCalledWith("openai-codex", {
      apiKey: "access-token"
    });
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
    expect(registerPiOAuthProvider).toHaveBeenCalledWith("openai-codex");
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
