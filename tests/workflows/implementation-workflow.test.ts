import { describe, expect, it } from "vitest";
import { gateResultFromAgentOutput } from "../../src/capabilities/quality-gates/gate-results.js";
import { loadNativeWorkflowDefinition } from "../../src/platform/native/native-run-context.js";

function reviewGateFrom(workflow: Awaited<ReturnType<typeof loadNativeWorkflowDefinition>>) {
  const implementation = workflow.graph.nodes.find((node) => node.id === "implementation");
  if (implementation?.type !== "pattern") {
    throw new Error("implementation pattern is missing");
  }
  const gate = implementation.gates?.find((candidate) => candidate.id === "review");
  if (gate?.block_when === undefined) {
    throw new Error("implementation review gate is missing");
  }
  return { ...gate, block_when: gate.block_when };
}

function implementationPatternFrom(
  workflow: Awaited<ReturnType<typeof loadNativeWorkflowDefinition>>
) {
  const implementation = workflow.graph.nodes.find((node) => node.id === "implementation");
  if (implementation?.type !== "pattern") {
    throw new Error("implementation pattern is missing");
  }
  return implementation;
}

describe("bundled implementation workflow", () => {
  it("uses optional validation from the selected repository contract", async () => {
    const workflow = await loadNativeWorkflowDefinition({
      projectRoot: process.cwd(),
      workflowId: "implementation"
    });
    const validationConfiguration = workflow.graph.nodes.find(
      (node) => node.id === "validation_configuration"
    );
    expect(validationConfiguration).toMatchObject({
      type: "built_in",
      uses: "validation.repository_configuration",
      after: ["preflight"]
    });
    expect(workflow.graph.nodes.find((node) => node.id === "workspace")).toMatchObject({
      after: ["validation_configuration"]
    });
    expect(workflow.graph.nodes.find((node) => node.id === "task_context")).toMatchObject({
      after: ["validation_configuration"]
    });

    const validationGate = implementationPatternFrom(workflow).gates?.find(
      (gate) => gate.id === "validation"
    );
    expect(validationGate?.input).toEqual({
      commands: {
        expression: "$.steps.validation_configuration.commands"
      },
      env_allowlist: {
        expression: "$.steps.validation_configuration.env_allowlist"
      },
      max_output_bytes: {
        expression: "$.config.implementation.validation.max_output_bytes"
      }
    });
  });

  it("blocks technical review findings that match the reviewer output schema", async () => {
    const workflow = await loadNativeWorkflowDefinition({
      projectRoot: process.cwd(),
      workflowId: "implementation"
    });
    const gate = reviewGateFrom(workflow);
    expect(gate.input?.subject).toEqual({
      gate: { expression: "$.gate" },
      task_context: { expression: "$.steps.task_context" },
      implementation_plan: { expression: "$.steps.implementation_plan" }
    });
    const blockingFinding = {
      title: "Broken behavior",
      severity: "high",
      confidence: "high",
      description: "The changed behavior is incorrect.",
      evidence: [],
      recommendation: "Repair the behavior."
    };

    const result = await gateResultFromAgentOutput({
      id: gate.id,
      type: gate.type,
      blockWhen: gate.block_when,
      feedback: gate.feedback,
      output: {
        findings: [blockingFinding],
        reviewed_ranges: [],
        summary: "One blocking defect."
      },
      expressionRoot: {
        gate: {
          findings: [blockingFinding],
          reviewed_ranges: [],
          summary: "One blocking defect."
        }
      }
    });

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("Broken behavior");
  });

  it("does not turn advisory findings into an automatic repair loop", async () => {
    const workflow = await loadNativeWorkflowDefinition({
      projectRoot: process.cwd(),
      workflowId: "implementation"
    });
    const gate = reviewGateFrom(workflow);
    const output = {
      findings: [{
        title: "Minor cleanup",
        severity: "low",
        confidence: "medium",
        description: "A small cleanup is possible.",
        evidence: [],
        recommendation: "Consider simplifying it."
      }],
      reviewed_ranges: [],
      summary: "Only advisory feedback."
    };

    await expect(gateResultFromAgentOutput({
      id: gate.id,
      type: gate.type,
      blockWhen: gate.block_when,
      feedback: gate.feedback,
      output,
      expressionRoot: { gate: output }
    })).resolves.toMatchObject({ passed: true });
  });
});
