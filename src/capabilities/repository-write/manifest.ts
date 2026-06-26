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
      "local-exec.command_read_policy",
      "local-exec.command_write_policy",
      "repository-workspace.capture_policy",
      "git.commit_side_effect",
      "change-request.create_side_effect"
    ]
  },
  re_exports: {
    built_ins: [
      "local-exec.command.read",
      "local-exec.command.write",
      "repository-workspace.capture",
      "git.commit",
      "change-request.create"
    ],
    patterns: ["quality-gates.gated_agent_loop"],
    policies: [
      "local-exec.command_read_policy",
      "local-exec.command_write_policy",
      "repository-workspace.capture_policy",
      "git.commit_side_effect",
      "change-request.create_side_effect"
    ],
    ports: [
      "local-exec.command_port",
      "local-exec.artifact_publisher",
      "local-exec.event_sink",
      "repository-workspace.manager",
      "repository-workspace.lock_manager",
      "repository-workspace.event_sink",
      "git.repository",
      "change-request.provider"
    ]
  },
  docs: [{ title: "Repository write capability bundle" }]
});
