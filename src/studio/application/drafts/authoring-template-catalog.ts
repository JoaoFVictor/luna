import { StudioDraftTemplateCatalogSchema } from "../../contracts/draft-authoring.js";

const TEMPLATE_VERSION = "1";
const WORKFLOW_FILES = [
  {
    relative_path: "workflow.yaml",
    media_type: "application/yaml",
    role: "definition"
  },
  {
    relative_path: "input.schema.json",
    media_type: "application/json",
    role: "schema"
  },
  {
    relative_path: "output.schema.json",
    media_type: "application/json",
    role: "schema"
  }
] as const;
const NO_CONFIG = { required: false, files: [] } as const;

export const BUILT_IN_STUDIO_DRAFT_TEMPLATE_CATALOG =
  StudioDraftTemplateCatalogSchema.parse({
    templates: [
      {
        id: "blank-workflow",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Workflow vazio",
        description: "Estrutura mínima para montar o fluxo do zero.",
        classification: "production_pattern",
        generated_files: WORKFLOW_FILES,
        parameters: [],
        reused_resources: [],
        capabilities: [],
        config: NO_CONFIG,
        runtime_requirements: [],
        provider_requirements: [],
        side_effects: [],
        graph_preview: { nodes: [], edges: [] }
      },
      {
        id: "read-only-pipeline",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Pipeline read-only",
        description: "Preflight determinístico com publicação de artifact JSON.",
        classification: "production_pattern",
        generated_files: WORKFLOW_FILES,
        parameters: [],
        reused_resources: [],
        capabilities: ["runtime", "artifacts"],
        config: NO_CONFIG,
        runtime_requirements: [],
        provider_requirements: [],
        side_effects: [],
        graph_preview: {
          nodes: [
            {
              id: "preflight",
              type: "built_in",
              registration_id: "runtime.preflight"
            }
          ],
          edges: []
        }
      },
      {
        id: "agent-workflow",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Workflow com agent",
        description: "Coleta contexto, executa um agent existente e publica o resultado.",
        classification: "production_pattern",
        generated_files: WORKFLOW_FILES,
        parameters: [
          {
            id: "agent",
            label: "Agent",
            kind: "agent",
            required: true,
            allowed_modes: ["read_only", "trusted_local_write"]
          }
        ],
        reused_resources: [
          { parameter_id: "agent", resource_kind: "agent", behavior: "reuse" }
        ],
        capabilities: ["context", "agents", "artifacts"],
        config: NO_CONFIG,
        runtime_requirements: [],
        provider_requirements: [],
        side_effects: [
          {
            id: "selected-agent-tools",
            certainty: "potential",
            semantics: "unknown",
            description: "O agent reutilizado pode declarar tools ou subagents; revise o Agent Studio e o plano antes de executar.",
            operation_ids: []
          }
        ],
        graph_preview: {
          nodes: [
            {
              id: "context",
              type: "built_in",
              registration_id: "context.collect_context"
            },
            {
              id: "agent_task",
              type: "agent",
              registration_parameter: "agent"
            }
          ],
          edges: [{ from: "context", to: "agent_task" }]
        }
      },
      {
        id: "parallel-review",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Review paralelo",
        description: "Coleta contexto, executa dois reviewers em paralelo e consolida um relatório determinístico.",
        classification: "production_pattern",
        generated_files: WORKFLOW_FILES,
        parameters: [
          { id: "primary_reviewer", label: "Reviewer principal", kind: "agent", required: true, allowed_modes: ["read_only"] },
          { id: "secondary_reviewer", label: "Reviewer secundário", kind: "agent", required: true, allowed_modes: ["read_only"] }
        ],
        reused_resources: [
          { parameter_id: "primary_reviewer", resource_kind: "agent", behavior: "reuse" },
          { parameter_id: "secondary_reviewer", resource_kind: "agent", behavior: "reuse" }
        ],
        capabilities: ["context", "agents", "reports", "artifacts"],
        config: NO_CONFIG,
        runtime_requirements: [],
        provider_requirements: [],
        side_effects: [
          {
            id: "selected-reviewer-tools",
            certainty: "potential",
            semantics: "unknown",
            description: "Os reviewers reutilizados podem declarar tools, MCP ou subagents; o plano de execução resolve e bloqueia incompatibilidades.",
            operation_ids: []
          }
        ],
        graph_preview: {
          nodes: [
            { id: "context", type: "built_in", registration_id: "context.collect_context" },
            { id: "primary_review", type: "agent", registration_parameter: "primary_reviewer" },
            { id: "secondary_review", type: "agent", registration_parameter: "secondary_reviewer" },
            { id: "report", type: "built_in", registration_id: "reports.final_report" }
          ],
          edges: [
            { from: "context", to: "primary_review" },
            { from: "context", to: "secondary_review" },
            { from: "primary_review", to: "report" },
            { from: "secondary_review", to: "report" }
          ]
        }
      },
      {
        id: "gated-repair-loop",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Implementação com gated repair",
        description: "Executa um worker dentro do pattern oficial de repair e usa outro agent como gate de review.",
        classification: "production_pattern",
        generated_files: WORKFLOW_FILES,
        parameters: [
          { id: "worker", label: "Worker", kind: "agent", required: true, allowed_modes: ["read_only", "trusted_local_write"] },
          { id: "reviewer", label: "Reviewer do gate", kind: "agent", required: true, allowed_modes: ["read_only"] }
        ],
        reused_resources: [
          { parameter_id: "worker", resource_kind: "agent", behavior: "reuse" },
          { parameter_id: "reviewer", resource_kind: "agent", behavior: "reuse" }
        ],
        capabilities: ["context", "agents", "quality-gates", "artifacts"],
        config: NO_CONFIG,
        runtime_requirements: [],
        provider_requirements: [],
        side_effects: [
          {
            id: "selected-worker-tools",
            certainty: "potential",
            semantics: "unknown",
            description: "O worker pode editar o worktree se for trusted_local_write; tools e efeitos são confirmados no plano real.",
            operation_ids: []
          }
        ],
        graph_preview: {
          nodes: [
            { id: "context", type: "built_in", registration_id: "context.collect_context" },
            { id: "repair", type: "pattern", registration_id: "quality-gates.gated_agent_loop" }
          ],
          edges: [{ from: "context", to: "repair" }]
        }
      },
      {
        id: "human-approval-side-effect",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Aprovação antes de side effect",
        description: "Showcase avançado de aprovação humana antes de commit; exige resume pela CLI porque o Studio ainda não retoma gates.",
        classification: "showcase",
        generated_files: WORKFLOW_FILES,
        parameters: [],
        reused_resources: [],
        capabilities: ["hitl", "git", "artifacts"],
        config: NO_CONFIG,
        runtime_requirements: ["repository", "human_gate", "write_side_effect"],
        provider_requirements: [],
        side_effects: [
          {
            id: "git-commit",
            certainty: "declared",
            semantics: "write",
            description: "O node git.commit nasce com enabled=false; habilitá-lo exige editar o draft e confirmar novamente o plano de execução.",
            operation_ids: ["git.commit"]
          }
        ],
        graph_preview: {
          nodes: [
            { id: "approval", type: "human_gate", registration_id: "hitl.approval" },
            { id: "enforce_approval", type: "built_in", registration_id: "hitl.require_approval" },
            { id: "commit", type: "built_in", registration_id: "git.commit" }
          ],
          edges: [
            { from: "approval", to: "enforce_approval" },
            { from: "enforce_approval", to: "commit" }
          ]
        }
      },
      {
        id: "context-report",
        version: TEMPLATE_VERSION,
        resource_kind: "workflow",
        title: "Contexto para relatório",
        description: "Coleta contexto do repositório e publica um relatório Markdown sem chamar modelo.",
        classification: "production_pattern",
        generated_files: WORKFLOW_FILES,
        parameters: [],
        reused_resources: [],
        capabilities: ["context", "reports", "artifacts"],
        config: NO_CONFIG,
        runtime_requirements: ["repository"],
        provider_requirements: [],
        side_effects: [],
        graph_preview: {
          nodes: [
            { id: "context", type: "built_in", registration_id: "context.collect_context" },
            { id: "report", type: "built_in", registration_id: "reports.final_report" }
          ],
          edges: [{ from: "context", to: "report" }]
        }
      }
    ]
  });
