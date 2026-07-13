import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../src/core/agent-runtime/contracts.js";
import type { WorkflowBuiltInExecutor } from "../../src/core/workflow/execution-contracts.js";
import {
  compileNativeWorkflow,
  loadNativeWorkflowDefinition
} from "../../src/platform/native/native-run-context.js";
import { buildNativeWorkflowAgentInputs } from "../../src/platform/native/native-agent-inputs.js";
import {
  resumeCompiledWorkflow,
  runCompiledWorkflow
} from "../../src/runtime/langgraph/workflow-runner.js";
import { createMemoryArtifactManifestStore } from "../../src/runtime/backends/memory/artifacts.js";
import { createMemoryCheckpointStore } from "../../src/runtime/backends/memory/checkpoints.js";
import { createMemoryEventStore } from "../../src/runtime/backends/memory/events.js";
import { createMemoryInterruptStore } from "../../src/runtime/backends/memory/interrupts.js";
import { createMemoryRuntimeLogStore } from "../../src/runtime/backends/memory/runtime-log.js";

describe("bundled social-post workflow", () => {
  it("uses one durable human-review loop and publishes only after approval", async () => {
    const projectRoot = process.cwd();
    const workflow = await loadNativeWorkflowDefinition({
      projectRoot,
      workflowId: "social-post"
    });
    const compiled = await compileNativeWorkflow({
      workflow,
      agentsRoot: path.join(projectRoot, "agents")
    });

    expect(compiled.compiled.nodes.map((node) => node.id)).toEqual([
      "editorial",
      "publish"
    ]);
    const editorial = workflow.graph.nodes.find((node) => node.id === "editorial");
    expect(editorial).toMatchObject({
      type: "loop",
      repeat_when: { expression: "$.steps.review.action = 'request_changes'" },
      halt_when: { expression: "$.result.action = 'reject'" }
    });
    if (editorial?.type !== "loop") throw new Error("editorial loop missing");
    expect(editorial.body.nodes.map((node) => node.id)).toEqual([
      "draft",
      "image",
      "review"
    ]);
    expect(editorial.body.nodes.find((node) => node.id === "draft")).toMatchObject({
      type: "agent",
      agent: "social-post-writer"
    });
    expect(editorial.body.nodes.find((node) => node.id === "image")).toMatchObject({
      type: "built_in",
      after: ["draft"],
      uses: "image-generation.generate",
      when: { expression: expect.stringContaining("'image' in $.steps.review.targets") },
      policies: [{
        uses: "image-generation.generate_side_effect",
        config: { operation_id: "image-generation.generate" }
      }]
    });
    expect(editorial.body.nodes.find((node) => node.id === "review")).toMatchObject({
      type: "human_gate",
      after: ["image"],
      uses: "hitl.review"
    });
    expect(workflow.graph.nodes.find((node) => node.id === "publish")).toMatchObject({
      after: ["editorial"],
      policies: [{
        uses: "social-post.publish_side_effect",
        config: { operation_id: "social-post.publish" }
      }],
      input: {
        image_asset: { expression: "$.steps.editorial.image.asset" }
      }
    });
  });

  it("terminates a real-schema rejection successfully without publishing", async () => {
    const projectRoot = process.cwd();
    const workflow = await loadNativeWorkflowDefinition({
      projectRoot,
      workflowId: "social-post"
    });
    const { compiled, workflow: compiledWorkflow } = await compileNativeWorkflow({
      workflow,
      agentsRoot: path.join(projectRoot, "agents")
    });
    const agentInputs = await buildNativeWorkflowAgentInputs({
      workflow: compiledWorkflow,
      agentsRoot: path.join(projectRoot, "agents"),
      configRoot: path.join(projectRoot, "config")
    });
    const publish = vi.fn(() => ({
      operation_id: "social-post.publish",
      provider: "x",
      provider_id: "x",
      external_id: "post-1",
      url: "https://x.test/post-1",
      text: "Luna torna workflows com agentes explícitos.",
      media_id: "media-1"
    }));
    const runAgent = vi.fn(async (agentInput: Parameters<AgentRuntimePort["runAgent"]>[0]) => {
      const input = agentInput.input as {
        readonly previous_draft?: { readonly image_prompt?: string };
        readonly review_feedback?: readonly {
          readonly comment?: string;
          readonly targets?: readonly string[];
        }[];
      };
      const basePrompt = input.previous_draft?.image_prompt ??
        "Geometric workflow graph on a dark blue background";
      const feedback = input.review_feedback?.at(-1);
      const imagePrompt = feedback?.targets?.includes("image") === true
        ? `${basePrompt}; refined: ${feedback.comment ?? ""}`.slice(0, 4000)
        : basePrompt;
      return {
        output: {
          text: "Luna torna workflows com agentes explícitos.",
          image_prompt: imagePrompt,
          strategy: "Mensagem técnica e direta.",
          character_count: 45,
          claims_to_verify: []
        }
      };
    });
    const agentRuntime: AgentRuntimePort = {
      describe: () => ({
        id: "test",
        display_name: "Test agent runtime",
        supported_runtime_requirements: [],
        supported_tool_protocols: []
      }),
      validate: () => undefined,
      runAgent
    };
    const backends = {
      artifacts: createMemoryArtifactManifestStore(),
      checkpoints: createMemoryCheckpointStore(),
      events: createMemoryEventStore(),
      interrupts: createMemoryInterruptStore(),
      runtimeLogs: createMemoryRuntimeLogStore()
    };
    const artifactPublisher = {
      async publish({ node_id, path: artifactPath }: { node_id: string; path: string }) {
        return {
          id: artifactPath,
          uri: `memory://${artifactPath}`,
          node_id
        };
      },
      async verify(ref: { id: string; uri: string; node_id: string }) {
        return ref.id === "image-1" &&
          ref.uri === "memory://image-1.png" &&
          ref.node_id.startsWith("editorial:iteration-") &&
          ref.node_id.endsWith(":image");
      }
    };
    const imagePrompts: string[] = [];
    const builtIns: Record<string, WorkflowBuiltInExecutor> = {
      "image-generation.generate": ({ node, input }) => {
        const imageInput = input as {
          readonly prompt: string;
          readonly size: string;
          readonly quality: string;
        };
        imagePrompts.push(imageInput.prompt);
        return {
          operation_id: "image-generation.generate",
          provider: "pi-imagegen",
          provider_id: "pi-imagegen",
          model: "gpt-image-1",
          prompt: imageInput.prompt,
          size: imageInput.size,
          quality: imageInput.quality,
          media_type: "image/png",
          asset: {
            id: "image-1",
            uri: "memory://image-1.png",
            node_id: node.id,
            media_type: "image/png",
            content_hash: `sha256:${"a".repeat(64)}`,
            size_bytes: 8
          },
          metadata: {
            provider: "pi-imagegen",
            model: "gpt-image-1",
            prompt: imageInput.prompt,
            size: imageInput.size,
            quality: imageInput.quality,
            media_type: "image/png"
          }
        };
      },
      "social-post.publish": publish
    };
    const common = {
      compiled,
      workflow: compiledWorkflow,
      backends,
      agentInputs,
      agentRuntime,
      artifactPublisher,
      builtIns
    };
    const invocation = {
      version: "2026-06",
      source: "manual",
      event: "social_post_brief",
      payload: {
        topic: "Luna",
        objective: "Apresentar o workflow",
        audience: "Desenvolvedores",
        tone: "Direto",
        language: "pt-BR"
      }
    };
    const config = {
      image_generation: {
        provider: "pi-imagegen",
        size: "1024x1024",
        quality: "medium"
      },
      social_post: { provider: "x", auth_instance: "default" }
    };
    let result = await runCompiledWorkflow({
      ...common,
      invocation,
      config,
      run: {
        run_id: "social-post-reject-real-schema",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T00:00:00.000Z"
      }
    });
    expect(result.status).toBe("waiting_for_input");
    if (result.status !== "waiting_for_input") throw new Error("expected review");

    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: { action: "approve", unexpected: true }
    })).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });

    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Change an unknown target",
        targets: ["unknown"]
      }
    })).rejects.toMatchObject({ code: "runtime_node_output_schema_invalid" });

    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Use more contrast",
        targets: ["image"]
      }
    });
    expect(result.status).toBe("waiting_for_input");
    if (result.status !== "waiting_for_input") throw new Error("expected second review");

    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Add more whitespace",
        targets: ["image"]
      }
    });
    expect(result.status).toBe("waiting_for_input");
    if (result.status !== "waiting_for_input") throw new Error("expected third review");
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(imagePrompts).toHaveLength(3);
    expect(imagePrompts[1]).toContain("Use more contrast");
    expect(imagePrompts[2]).toContain("Use more contrast");
    expect(imagePrompts[2]).toContain("Add more whitespace");

    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: { action: "reject", comment: "Não publicar" }
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error("expected rejection success");
    expect(result.output).toMatchObject({
      action: "reject",
      decision: { action: "reject", comment: "Não publicar" }
    });
    expect(result.state.steps.publish).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();

    let approved = await runCompiledWorkflow({
      ...common,
      invocation,
      config,
      run: {
        run_id: "social-post-approve-real-schema",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T01:00:00.000Z"
      }
    });
    expect(approved.status).toBe("waiting_for_input");
    if (approved.status !== "waiting_for_input") throw new Error("expected approval review");
    approved = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-approve-real-schema",
      checkpoint_id: approved.checkpoint_id,
      interrupt_id: approved.interrupt_id,
      decision: { action: "approve" }
    });
    expect(approved.status).toBe("succeeded");
    if (approved.status !== "succeeded") throw new Error("expected publish success");
    expect(approved.output).toMatchObject({
      operation_id: "social-post.publish",
      external_id: "post-1"
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
