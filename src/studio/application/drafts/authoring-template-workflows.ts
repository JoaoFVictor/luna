import type { StudioDraftTemplateSelection } from "../../contracts/draft-authoring.js";
import {
  agentParameters,
  assertTemplateParameters,
  requiredAgent,
  schemaCapabilities,
  templateArtifact as artifact,
  type TemplateDescriptor
} from "./authoring-template-parameters.js";

type WorkflowTemplateBuilderInput = {
  readonly resourceId: string;
  readonly selection: StudioDraftTemplateSelection;
  readonly template: TemplateDescriptor;
};

type WorkflowTemplateBuilder = (
  input: WorkflowTemplateBuilderInput
) => unknown;

const readOnlyPipeline: WorkflowTemplateBuilder = ({ resourceId, selection, template }) => {
  assertTemplateParameters(selection, []);
  return {
    id: resourceId,
    type: "workflow",
    mode: "read_only",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    capabilities: template.capabilities,
    requires: { repository: true },
    nodes: [
      {
        id: "preflight",
        type: "built_in",
        uses: "runtime.preflight",
        artifacts: [artifact("preflight.json", "$.steps.preflight", "json")]
      }
    ]
  };
};

const agentWorkflow: WorkflowTemplateBuilder = ({ resourceId, selection, template }) => {
  const agent = requiredAgent(
    agentParameters(selection, template, ["agent"]),
    "agent"
  );
  return {
    id: resourceId,
    type: "workflow",
    mode: agent.mode,
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    capabilities: [...template.capabilities, ...schemaCapabilities([agent])],
    requires: { repository: true },
    nodes: [
      {
        id: "context",
        type: "built_in",
        uses: "context.collect_context",
        input: { agents: [agent.id] }
      },
      {
        id: "agent_task",
        type: "agent",
        agent: agent.id,
        output_schema: agent.outputSchema,
        input: {
          invocation: { expression: "$.invocation" },
          context: { expression: "$.steps.context" }
        },
        artifacts: [artifact("agent-result.json", "$.steps.agent_task", "json")],
        after: ["context"]
      }
    ]
  };
};

const parallelReview: WorkflowTemplateBuilder = ({ resourceId, selection, template }) => {
  const agents = agentParameters(selection, template, [
    "primary_reviewer",
    "secondary_reviewer"
  ]);
  const primary = requiredAgent(agents, "primary_reviewer");
  const secondary = requiredAgent(agents, "secondary_reviewer");
  return {
    id: resourceId,
    type: "workflow",
    mode: "read_only",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    capabilities: [
      ...template.capabilities,
      ...schemaCapabilities([primary, secondary])
    ],
    requires: { repository: true },
    execution: {
      max_concurrency: 2,
      agent_sessions: { read_only: "shared" }
    },
    nodes: [
      {
        id: "context",
        type: "built_in",
        uses: "context.collect_context",
        input: { agents: [primary.id, secondary.id] }
      },
      {
        id: "primary_review",
        type: "agent",
        agent: primary.id,
        output_schema: primary.outputSchema,
        input: {
          invocation: { expression: "$.invocation" },
          context: { expression: "$.steps.context" }
        },
        artifacts: [artifact("primary-review.json", "$.steps.primary_review", "json")],
        after: ["context"]
      },
      {
        id: "secondary_review",
        type: "agent",
        agent: secondary.id,
        output_schema: secondary.outputSchema,
        input: {
          invocation: { expression: "$.invocation" },
          context: { expression: "$.steps.context" }
        },
        artifacts: [artifact("secondary-review.json", "$.steps.secondary_review", "json")],
        after: ["context"]
      },
      {
        id: "report",
        type: "built_in",
        uses: "reports.final_report",
        input: {
          title: "Parallel review",
          sections: [
            {
              heading: "Primary reviewer",
              content: { expression: "$.steps.primary_review" }
            },
            {
              heading: "Secondary reviewer",
              content: { expression: "$.steps.secondary_review" }
            }
          ]
        },
        artifacts: [artifact("parallel-review.md", "$.steps.report.report", "markdown")],
        after: ["primary_review", "secondary_review"]
      }
    ]
  };
};

const gatedRepairLoop: WorkflowTemplateBuilder = ({ resourceId, selection, template }) => {
  const agents = agentParameters(selection, template, ["worker", "reviewer"]);
  const worker = requiredAgent(agents, "worker");
  const reviewer = requiredAgent(agents, "reviewer");
  return {
    id: resourceId,
    type: "workflow",
    mode: worker.mode,
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    capabilities: [
      ...template.capabilities,
      ...schemaCapabilities([worker, reviewer])
    ],
    requires: { repository: true },
    nodes: [
      {
        id: "context",
        type: "built_in",
        uses: "context.collect_context",
        input: { agents: [worker.id, reviewer.id] }
      },
      {
        id: "repair",
        type: "pattern",
        uses: "quality-gates.gated_agent_loop",
        worker: worker.id,
        input: {
          invocation: { expression: "$.invocation" },
          context: { expression: "$.steps.context" }
        },
        gates: [
          {
            id: "review",
            type: "quality-gates.agent_review",
            input: {
              review_agent: reviewer.id,
              context: { expression: "$.steps.context" },
              subject: { expression: "$.gate" }
            },
            block_when: { expression: "$.gate.decision = 'fail'" },
            feedback: { expression: "$.gate.feedback" }
          }
        ],
        repair: { attempts: 2 },
        artifacts: [artifact("gated-repair.json", "$.steps.repair", "json")],
        after: ["context"]
      }
    ]
  };
};

const humanApprovalSideEffect: WorkflowTemplateBuilder = ({
  resourceId,
  selection,
  template
}) => {
  assertTemplateParameters(selection, []);
  return {
    id: resourceId,
    type: "workflow",
    mode: "trusted_local_write",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    capabilities: template.capabilities,
    requires: { repository: true },
    nodes: [
      {
        id: "approval",
        type: "human_gate",
        uses: "hitl.approval",
        input: { prompt: "Approve enabling the protected publishing step?" },
        artifacts: [artifact("approval.json", "$.steps.approval", "json")]
      },
      {
        id: "enforce_approval",
        type: "built_in",
        uses: "hitl.require_approval",
        input: { decision: { expression: "$.steps.approval" } },
        after: ["approval"]
      },
      {
        id: "commit",
        type: "built_in",
        uses: "git.commit",
        policies: [
          {
            uses: "git.commit_side_effect",
            config: { operation_id: "git.commit" }
          }
        ],
        input: {
          operation_id: "git.commit",
          enabled: false,
          skipped: true,
          reason: "Template default: edit this node explicitly after reviewing the approval boundary"
        },
        artifacts: [artifact("commit.json", "$.steps.commit", "json")],
        after: ["enforce_approval"]
      }
    ]
  };
};

const contextReport: WorkflowTemplateBuilder = ({ resourceId, selection, template }) => {
  assertTemplateParameters(selection, []);
  return {
    id: resourceId,
    type: "workflow",
    mode: "read_only",
    input_schema: "input.schema.json",
    output_schema: "output.schema.json",
    capabilities: template.capabilities,
    requires: { repository: true },
    nodes: [
      {
        id: "context",
        type: "built_in",
        uses: "context.collect_context",
        input: { agents: [] },
        artifacts: [artifact("context.json", "$.steps.context", "json")]
      },
      {
        id: "report",
        type: "built_in",
        uses: "reports.final_report",
        input: {
          title: "Repository context",
          sections: [
            {
              heading: "Collected context",
              content: { expression: "$.steps.context" }
            }
          ]
        },
        artifacts: [artifact("context-report.md", "$.steps.report.report", "markdown")],
        after: ["context"]
      }
    ]
  };
};

const WORKFLOW_TEMPLATE_BUILDERS = new Map<string, WorkflowTemplateBuilder>([
  ["read-only-pipeline", readOnlyPipeline],
  ["agent-workflow", agentWorkflow],
  ["parallel-review", parallelReview],
  ["gated-repair-loop", gatedRepairLoop],
  ["human-approval-side-effect", humanApprovalSideEffect],
  ["context-report", contextReport]
]);

export function buildWorkflowTemplateDefinition(
  resourceId: string,
  selection: StudioDraftTemplateSelection,
  template: TemplateDescriptor
): unknown | undefined {
  return WORKFLOW_TEMPLATE_BUILDERS.get(selection.template_id)?.({
    resourceId,
    selection,
    template
  });
}
