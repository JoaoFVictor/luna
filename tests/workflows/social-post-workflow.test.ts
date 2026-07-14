import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort } from "../../src/core/agent-runtime/contracts.js";
import type { WorkflowBuiltInExecutor } from "../../src/core/workflow/execution-contracts.js";
import { socialPostApplyRevisionScopeBuiltIn } from "../../src/capabilities/social-post/built-ins.js";
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
      "proposal",
      "draft",
      "image",
      "prepare",
      "review"
    ]);
    expect(editorial.body.nodes.find((node) => node.id === "proposal")).toMatchObject({
      type: "agent",
      agent: "social-post-writer"
    });
    expect(editorial.body.nodes.find((node) => node.id === "draft")).toMatchObject({
      type: "built_in",
      uses: "social-post.apply_revision_scope",
      input: {
        proposed_draft: { expression: "$.steps.proposal" },
        previous_draft: { expression: expect.stringContaining("$.steps.draft") },
        targets: { expression: expect.stringContaining("$.steps.review.targets") }
      }
    });
    expect(editorial.body.nodes.find((node) => node.id === "image")).toMatchObject({
      type: "built_in",
      uses: "image-generation.generate",
      when: { expression: expect.stringContaining("'image' in $.steps.review.targets") },
      policies: [{
        uses: "image-generation.generate_side_effect",
        config: { operation_id: "image-generation.generate" }
      }]
    });
    expect(editorial.body.nodes.find((node) => node.id === "review")).toMatchObject({
      type: "human_gate",
      uses: "hitl.review"
    });
    expect(editorial.body.nodes.find((node) => node.id === "prepare")).toMatchObject({
      type: "built_in",
      uses: "social-post.prepare",
      input: {
        text: { expression: "$.steps.draft.text" },
        image_asset: { expression: "$.steps.image.asset" }
      }
    });
    expect(editorial.body.nodes.every((node) => node.after === undefined)).toBe(true);
    expect(workflow.graph.nodes.find((node) => node.id === "publish")).toMatchObject({
      after: ["editorial"],
      policies: [{
        uses: "social-post.publish_side_effect",
        config: { operation_id: "social-post.publish" }
      }],
      input: {
        text: { expression: "$.steps.editorial.draft.text" },
        image_asset: { expression: "$.steps.editorial.image.asset" },
        preparation: { expression: "$.steps.editorial.prepared" }
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
      const call = runAgent.mock.calls.length;
      return {
        output: {
          text: `Texto proposto ${call}`,
          image_prompt: `Prompt proposto ${call}`,
          strategy: `Estratégia proposta ${call}`,
          character_count: 1,
          claims_to_verify: [`Claim proposto ${call}`]
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
        return /^image-[1-9][0-9]*$/u.test(ref.id) &&
          ref.uri === `memory://${ref.id}.png` &&
          ref.node_id.startsWith("editorial:iteration-") &&
          ref.node_id.endsWith(":image");
      }
    };
    const imagePrompts: string[] = [];
    let generatedImageSize = 8;
    const prepare = vi.fn(({ input }: { readonly input: unknown }) => {
      const preparation = input as {
        readonly provider_id: string;
        readonly text: string;
        readonly image_asset: {
          readonly size_bytes: number;
          readonly media_type: "image/png";
          readonly content_hash: string;
        };
      };
      const imageMaxBytes = 5 * 1024 * 1024;
      const valid = preparation.image_asset.size_bytes <= imageMaxBytes;
      return {
        provider_id: preparation.provider_id,
        text_hash: `sha256:${createHash("sha256").update(preparation.text, "utf8").digest("hex")}`,
        image_content_hash: preparation.image_asset.content_hash,
        validation: {
          valid,
          code: valid ? "ready" : "image_too_large",
          message: valid
            ? "Imagem validada e pronta para publicação."
            : "Imagem acima do limite do X. Solicite uma nova imagem menor.",
          text_weighted_length: [...preparation.text].length,
          text_max_weighted_length: 280,
          text_policy_id: "x.twitter-text.weighted-length",
          text_policy_revision: "twitter-text@3.1.0/config-v3",
          image_size_bytes: preparation.image_asset.size_bytes,
          image_max_bytes: imageMaxBytes,
          image_media_type: preparation.image_asset.media_type,
          image_width: valid ? 1 : 0,
          image_height: valid ? 1 : 0
        }
      };
    });
    const builtIns: Record<string, WorkflowBuiltInExecutor> = {
      "social-post.apply_revision_scope": ({ input, state: runtimeState }) =>
        socialPostApplyRevisionScopeBuiltIn.run({
          state: runtimeState,
          input: input as Record<string, unknown>
        }),
      "image-generation.generate": ({ node, input }) => {
        const imageInput = input as {
          readonly prompt: string;
          readonly size: string;
          readonly quality: string;
        };
        imagePrompts.push(imageInput.prompt);
        const generation = imagePrompts.length;
        const contentHashDigit = generation.toString(16);
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
            id: `image-${generation}`,
            uri: `memory://image-${generation}.png`,
            node_id: node.id,
            media_type: "image/png",
            content_hash: `sha256:${contentHashDigit.repeat(64)}`,
            size_bytes: generatedImageSize
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
      "social-post.prepare": prepare,
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
        quality: "medium",
        timeout_ms: 360_000
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
    const preparedInput = (call: number) => prepare.mock.calls[call]?.[0].input as {
      readonly text: string;
      readonly image_asset: {
        readonly id: string;
        readonly uri: string;
        readonly content_hash: string;
      };
    };
    const initialPrepared = preparedInput(0);

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
    const imageOnlyPrepared = preparedInput(1);
    expect(imageOnlyPrepared.text).toBe(initialPrepared.text);
    expect(imageOnlyPrepared.image_asset.content_hash).not.toBe(
      initialPrepared.image_asset.content_hash
    );

    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Make the text shorter",
        targets: ["text"]
      }
    });
    expect(result.status).toBe("waiting_for_input");
    if (result.status !== "waiting_for_input") throw new Error("expected third review");
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(imagePrompts).toEqual(["Prompt proposto 1", "Prompt proposto 2"]);
    const imageOnlyEffectiveDraft = (
      runAgent.mock.calls[2]?.[0].input as {
        readonly previous_draft: Record<string, unknown>;
      }
    ).previous_draft;
    expect(imageOnlyEffectiveDraft).toEqual({
      text: "Texto proposto 1",
      image_prompt: "Prompt proposto 2",
      strategy: "Estratégia proposta 1",
      character_count: [..."Texto proposto 1"].length,
      claims_to_verify: ["Claim proposto 1"]
    });
    const textOnlyPrepared = preparedInput(2);
    expect(textOnlyPrepared.text).not.toBe(imageOnlyPrepared.text);
    expect(textOnlyPrepared.image_asset).toEqual(imageOnlyPrepared.image_asset);
    expect(textOnlyPrepared.image_asset.content_hash).toBe(
      imageOnlyPrepared.image_asset.content_hash
    );
    expect(prepare.mock.results[2]?.value).toMatchObject({
      text_hash: `sha256:${createHash("sha256").update(textOnlyPrepared.text, "utf8").digest("hex")}`,
      image_content_hash: imageOnlyPrepared.image_asset.content_hash
    });

    result = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-reject-real-schema",
      checkpoint_id: result.checkpoint_id,
      interrupt_id: result.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Change text and image together",
        targets: ["text", "image"]
      }
    });
    expect(result.status).toBe("waiting_for_input");
    if (result.status !== "waiting_for_input") throw new Error("expected fourth review");
    expect(runAgent).toHaveBeenCalledTimes(4);
    const textOnlyEffectiveDraft = (
      runAgent.mock.calls[3]?.[0].input as {
        readonly previous_draft: Record<string, unknown>;
      }
    ).previous_draft;
    expect(textOnlyEffectiveDraft).toEqual({
      text: "Texto proposto 3",
      image_prompt: "Prompt proposto 2",
      strategy: "Estratégia proposta 3",
      character_count: [..."Texto proposto 3"].length,
      claims_to_verify: ["Claim proposto 3"]
    });
    expect(imagePrompts).toEqual([
      "Prompt proposto 1",
      "Prompt proposto 2",
      "Prompt proposto 4"
    ]);
    const bothPrepared = preparedInput(3);
    expect(bothPrepared.text).not.toBe(textOnlyPrepared.text);
    expect(bothPrepared.image_asset.content_hash).not.toBe(
      textOnlyPrepared.image_asset.content_hash
    );

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

    generatedImageSize = 5 * 1024 * 1024 + 1;
    let oversized = await runCompiledWorkflow({
      ...common,
      invocation,
      config,
      run: {
        run_id: "social-post-oversized-image",
        workflow_id: workflow.id,
        attempt: 1,
        started_at: "2026-07-12T02:00:00.000Z"
      }
    });
    expect(oversized.status).toBe("waiting_for_input");
    if (oversized.status !== "waiting_for_input") throw new Error("expected oversized review");
    const [oversizedInterrupt] = await backends.interrupts.list("social-post-oversized-image");
    expect(oversizedInterrupt?.payload?.review?.approval).toEqual({
      allowed: false,
      reason: "Imagem acima do limite do X. Solicite uma nova imagem menor."
    });
    await expect(resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-oversized-image",
      checkpoint_id: oversized.checkpoint_id,
      interrupt_id: oversized.interrupt_id,
      decision: { action: "approve" }
    })).rejects.toMatchObject({
      code: "runtime_node_output_schema_invalid",
      details: { approval_blocked: true }
    });
    expect((await backends.interrupts.get(oversized.interrupt_id))?.status).toBe("pending");
    expect(publish).toHaveBeenCalledTimes(1);

    generatedImageSize = 8;
    oversized = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-oversized-image",
      checkpoint_id: oversized.checkpoint_id,
      interrupt_id: oversized.interrupt_id,
      decision: {
        action: "request_changes",
        comment: "Gere uma imagem menor",
        targets: ["image"]
      }
    });
    expect(oversized.status).toBe("waiting_for_input");
    if (oversized.status !== "waiting_for_input") throw new Error("expected regenerated review");
    expect((await backends.interrupts.get(oversized.interrupt_id))
      ?.payload?.review?.approval?.allowed).toBe(true);
    oversized = await resumeCompiledWorkflow({
      ...common,
      thread_id: "social-post-oversized-image",
      checkpoint_id: oversized.checkpoint_id,
      interrupt_id: oversized.interrupt_id,
      decision: { action: "approve" }
    });
    expect(oversized.status).toBe("succeeded");
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
