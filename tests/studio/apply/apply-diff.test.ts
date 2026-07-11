import { describe, expect, it } from "vitest";
import { renderStudioApplyTextDiff } from "../../../src/studio/application/apply/diff.js";

describe("Studio apply textual diff", () => {
  it.each([
    {
      path: "settings/credentials.json",
      before: '{"api_token":"json-before-secret","enabled":true}\n',
      after: '{"api_token":"json-after-secret","enabled":false}\n'
    },
    {
      path: "workflows/demo/workflow.yaml",
      before: "api_token: |\n  yaml-before-secret\nenabled: true\n",
      after: "api_token: |\n  yaml-after-secret\nenabled: false\n"
    }
  ])("redacts nested or block secrets in $path", ({ path, before, after }) => {
    const result = renderStudioApplyTextDiff({
      file: { root: "project", path },
      before: Buffer.from(before, "utf8"),
      after: Buffer.from(after, "utf8"),
      maxBytes: 16 * 1024
    });

    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("before-secret");
    expect(result.text).not.toContain("after-secret");
    expect(result.truncated).toBe(false);
  });
});
