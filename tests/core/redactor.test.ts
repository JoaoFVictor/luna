import { describe, expect, it } from "vitest";
import { redactString, redactValue } from "../../src/core/security/redactor.js";

describe("redactor", () => {
  it("redacts JSON values by secret-looking keys and token patterns", () => {
    const redacted = redactValue({
      api_token: "jira-token-value",
      nested: {
        note: "push with ghp_1234567890abcdefghijklmnopqrstuvwxyzABC"
      },
      public_count: 2
    });

    expect(redacted).toEqual({
      api_token: "[REDACTED]",
      nested: {
        note: "push with [REDACTED]"
      },
      public_count: 2
    });
  });

  it("redacts markdown strings containing auth headers and env-style secrets", () => {
    expect(
      redactString(
        [
          "# Report",
          "Authorization: Bearer jira-api-token-value",
          "Authorization: Basic dXNlckBleGFtcGxlLmNvbTp0b2tlbg==",
          "JIRA_API_TOKEN=token-from-env"
        ].join("\n")
      )
    ).toMatchInlineSnapshot(`
      "# Report
      Authorization: Bearer [REDACTED]
      Authorization: Basic [REDACTED]
      JIRA_API_TOKEN=[REDACTED]"
    `);
  });

  it("redacts markdown strings containing colon-form secret fields", () => {
    expect(
      redactString(
        [
          "# Report",
          "api_token: jira-api-token-value",
          "password: hunter2",
          "- clientSecret: quoted-secret",
          "public_count: 2"
        ].join("\n")
      )
    ).toMatchInlineSnapshot(`
      "# Report
      api_token: [REDACTED]
      password: [REDACTED]
      - clientSecret: [REDACTED]
      public_count: 2"
    `);
  });

  it("redacts command logs with GitHub tokens and inline bearer headers", () => {
    expect(
      redactString(
        "curl -H 'Authorization: Bearer abc.def.ghi' https://api.github.com/repos/o/r && token=ghp_1234567890abcdefghijklmnopqrstuvwxyzABC"
      )
    ).toBe(
      "curl -H 'Authorization: Bearer [REDACTED]' https://api.github.com/repos/o/r && token=[REDACTED]"
    );
  });
});
