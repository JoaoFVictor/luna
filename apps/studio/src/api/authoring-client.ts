import type {
  DraftCreateRequest,
  ExpressionEvaluationRequest,
  JsonValue,
  SchemaValidationRequest,
  StudioPath,
  YamlSourceOperation,
} from "@/api/types"
import { studioResponseContracts } from "@/api/response-contracts"
import type { StudioRequest } from "@/api/client-core"

type DraftFileEdit =
  | {
      action: "write"
      file: { root: "project" | "config"; path: string }
      content: string
    }
  | {
      action: "delete"
      file: { root: "project" | "config"; path: string }
    }

export class StudioAuthoringClient {
  readonly #request: StudioRequest

  constructor(request: StudioRequest) {
    this.#request = request
  }

  readonly workflows = (signal?: AbortSignal) => {
    return this.#request(
      "/workflows",
      { signal },
      studioResponseContracts.workflows,
    )
  }

  readonly agents = (signal?: AbortSignal) => {
    return this.#request("/agents", { signal }, studioResponseContracts.agents)
  }

  readonly library = (signal?: AbortSignal) => {
    return this.#request("/library", { signal }, studioResponseContracts.library)
  }

  readonly evaluateExpression = (request: ExpressionEvaluationRequest) => {
    return this.#request(
      "/expressions/evaluate",
      { method: "POST", body: request },
      studioResponseContracts.expressionEvaluation,
    )
  }

  readonly validateSchemaInstance = (request: SchemaValidationRequest) => {
    return this.#request(
      "/schemas/validate-instance",
      { method: "POST", body: request },
      studioResponseContracts.schemaValidation,
    )
  }

  readonly drafts = (signal?: AbortSignal) => {
    return this.#request(
      "/drafts?limit=100",
      { signal },
      studioResponseContracts.draftList,
    )
  }

  readonly draft = (draftId: string, signal?: AbortSignal) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}`,
      { signal },
      studioResponseContracts.draft,
    )
  }

  readonly draftTemplates = (signal?: AbortSignal) => {
    return this.#request(
      "/draft-templates",
      { signal },
      studioResponseContracts.draftTemplates,
    )
  }

  readonly createDraft = (request: DraftCreateRequest) => {
    return this.#request(
      "/drafts",
      {
        method: "POST",
        body: request,
      },
      studioResponseContracts.draft,
    )
  }

  readonly patchDraft = (
    draftId: string,
    etag: string,
    edits: DraftFileEdit[],
  ) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: { edits },
      },
      studioResponseContracts.draft,
    )
  }

  readonly editDraftSource = (
    draftId: string,
    etag: string,
    file: StudioPath,
    operations: readonly YamlSourceOperation[],
  ) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}/source-edits`,
      {
        method: "POST",
        headers: { "If-Match": etag },
        body: { file, operations },
      },
      studioResponseContracts.draft,
    )
  }

  readonly draftSourceView = (
    draftId: string,
    file: StudioPath,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ root: file.root, path: file.path })
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}/source-view?${query.toString()}`,
      { signal },
      studioResponseContracts.draftSourceView,
    )
  }

  readonly patchDraftLayout = (
    draftId: string,
    etag: string,
    layout: JsonValue,
  ) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: { layout },
      },
      studioResponseContracts.draft,
    )
  }

  readonly deleteDraft = (draftId: string, etag: string) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "DELETE",
        headers: { "If-Match": etag },
        body: {},
      },
      studioResponseContracts.empty,
    )
  }

  readonly validateDraft = (draftId: string, etag: string) => {
    return this.draftCommand(draftId, "validate", etag)
  }

  readonly compileDraft = (draftId: string, etag: string) => {
    return this.draftCommand(draftId, "compile", etag)
  }

  readonly planApply = (draftId: string) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}/plan-apply`,
      { method: "POST", body: {} },
      studioResponseContracts.applyPlan,
    )
  }

  readonly applyDraft = (
    draftId: string,
    etag: string,
    planToken: string,
    idempotencyKey: string,
  ) => {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}/apply`,
      {
        method: "POST",
        headers: { "If-Match": etag },
        body: {
          plan_token: planToken,
          idempotency_key: idempotencyKey,
        },
      },
      studioResponseContracts.applyResult,
    )
  }

  private draftCommand(draftId: string, command: string, etag: string) {
    return this.#request(
      `/drafts/${encodeURIComponent(draftId)}/${command}`,
      {
        method: "POST",
        headers: { "If-Match": etag },
        body: {},
      },
      studioResponseContracts.draftValidation,
    )
  }
}
