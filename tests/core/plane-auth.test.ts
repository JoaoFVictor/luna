import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPlaneAuth,
  planeAuthForInstance,
  type PlaneLunaAuthConfig
} from "../../src/core/providers/plane/auth.js";

const planeAuthFixture: PlaneLunaAuthConfig = {
  providers: {
    plane: {
      company: {
        base_url: "https://app.plane.so",
        auth_type: "api_key",
        api_key: "plane-secret-token"
      }
    }
  }
};

describe("Luna Plane auth", () => {
  it("loads Plane auth from luna.auth.json", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-plane-auth-"));
    await writeFile(
      path.join(projectRoot, "luna.auth.json"),
      JSON.stringify(planeAuthFixture),
      "utf8"
    );

    await expect(loadPlaneAuth(projectRoot)).resolves.toEqual(planeAuthFixture);
  });

  it("throws luna_auth_missing when luna.auth.json is missing", async () => {
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "luna-plane-auth-missing-")
    );
    await mkdir(path.join(projectRoot, "nested"));

    await expect(loadPlaneAuth(projectRoot)).rejects.toThrow(
      expect.objectContaining({ code: "luna_auth_missing" })
    );
  });

  it("throws plane_auth_missing when an instance is missing", () => {
    expect(() => planeAuthForInstance(planeAuthFixture, "other")).toThrow(
      expect.objectContaining({ code: "plane_auth_missing" })
    );
  });
});
