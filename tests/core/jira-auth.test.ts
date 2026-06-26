import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  jiraAuthForInstance,
  loadLunaAuth,
  type JiraLunaAuthConfig
} from "../../src/providers/jira/auth.js";

const lunaAuthFixture: JiraLunaAuthConfig = {
  providers: {
    jira: {
      company: {
        base_url: "https://company.atlassian.net",
        auth_type: "basic_api_token",
        email: "user@company.com",
        api_token: "secret-token"
      }
    }
  }
};

describe("Luna Jira auth", () => {
  it("loads Jira auth from luna.auth.json", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-auth-"));
    await writeFile(
      path.join(projectRoot, "luna.auth.json"),
      JSON.stringify(lunaAuthFixture),
      "utf8"
    );

    await expect(loadLunaAuth(projectRoot)).resolves.toEqual(lunaAuthFixture);
  });

  it("throws luna_auth_missing when luna.auth.json is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "luna-auth-missing-"));
    await mkdir(path.join(projectRoot, "nested"));

    await expect(loadLunaAuth(projectRoot)).rejects.toThrow(
      expect.objectContaining({ code: "luna_auth_missing" })
    );
  });

  it("throws jira_auth_missing when an instance is missing", () => {
    expect(() => jiraAuthForInstance(lunaAuthFixture, "other")).toThrow(
      expect.objectContaining({ code: "jira_auth_missing" })
    );
  });
});
