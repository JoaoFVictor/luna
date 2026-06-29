import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadLunaAuthFile
} from "../../src/core/auth/luna-auth-file.js";
import { resolveLunaAuthRoot } from "../../src/core/auth/root.js";

describe("Luna auth root", () => {
  it("loads Luna-owned auth from the single configured auth root", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-auth-root-"));
    const authRoot = path.join(projectRoot, ".luna", "auth");
    await mkdir(authRoot, { recursive: true });
    await writeFile(
      path.join(authRoot, "luna.auth.json"),
      JSON.stringify({
        providers: {
          webhooks: {
            github: { secret: "github-secret" }
          }
        }
      })
    );

    await expect(loadLunaAuthFile(projectRoot)).resolves.toEqual({
      providers: {
        webhooks: {
          github: { secret: "github-secret" }
        }
      }
    });
  });

  it("uses LUNA_AUTH_ROOT as the only override for the auth root", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-auth-project-"));
    const externalRoot = await mkdtemp(path.join(tmpdir(), "luna-auth-external-"));

    expect(resolveLunaAuthRoot(projectRoot, { LUNA_AUTH_ROOT: externalRoot })).toBe(
      externalRoot
    );
    expect(resolveLunaAuthRoot(projectRoot, { LUNA_AUTH_ROOT: "auth" })).toBe(
      path.join(projectRoot, "auth")
    );
  });
});
