import { capabilityManifest } from "../../core/capabilities/manifest.js";

export const manifest = capabilityManifest({
  id: "repository-write",
  kind: "composition",
  version: "2026.06.25",
  depends_on: [
    "local-exec",
    "repository-workspace",
    "git",
    "change-request",
    "quality-gates"
  ],
  presets: {
    default_policy_bundle: [
      "local-exec.command_policy",
      "git.commit_side_effect",
      "change-request.create_side_effect"
    ]
  },
  re_exports: {
    built_ins: [
      "repository-workspace.capture",
      "git.commit",
      "change-request.create"
    ],
    patterns: ["quality-gates.gated_agent_loop"],
    policies: [
      "local-exec.command_policy",
      "git.commit_side_effect",
      "change-request.create_side_effect"
    ],
    ports: [
      "local-exec.command_runner",
      "repository-workspace.manager",
      "git.repository",
      "change-request.provider"
    ]
  },
  docs: [{ title: "Repository write capability bundle" }]
});

