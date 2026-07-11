import type { BootstrapState, SessionState } from "@/api/types"
import {
  studioResponseContracts,
  type StudioResponseContract,
} from "@/api/response-contracts"
import { StudioHttpErrorEnvelopeSchema } from "../../../../src/studio/contracts/control-api.js"

export const STUDIO_API_PREFIX = "/api/studio/v1"

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const MAX_CAPABILITY_LENGTH = 4096

export class StudioApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly details: Readonly<Record<string, string | number | boolean | null>>

  constructor(options: {
    message: string
    status: number
    code: string
    requestId?: string
    details?: Readonly<Record<string, string | number | boolean | null>>
  }) {
    super(options.message)
    this.name = "StudioApiError"
    this.status = options.status
    this.code = options.code
    this.requestId = options.requestId
    this.details = options.details ?? {}
  }
}

export type StudioRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  csrf?: "required" | "session-establishment"
}

function parseErrorEnvelope(value: unknown) {
  const parsed = StudioHttpErrorEnvelopeSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function consumeLaunchCapability(): string | undefined {
  const rawHash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash
  const params = new URLSearchParams(rawHash)
  const capabilities = params.getAll("capability")

  if (capabilities.length > 0) {
    params.delete("capability")
    const remainingHash = params.toString()
    const safeUrl = `${window.location.pathname}${window.location.search}${
      remainingHash.length === 0 ? "" : `#${remainingHash}`
    }`
    window.history.replaceState(window.history.state, "", safeUrl)
  }

  if (capabilities.length === 0) return undefined
  if (
    capabilities.length !== 1 ||
    capabilities[0].length === 0 ||
    capabilities[0].length > MAX_CAPABILITY_LENGTH
  ) {
    throw new StudioApiError({
      status: 400,
      code: "studio_bootstrap_invalid",
      message: "A capability de inicialização do Studio é inválida.",
    })
  }
  return capabilities[0]
}

export interface StudioHttpClientApi {
  readonly sessionSnapshot: () => BootstrapState
  readonly subscribeSession: (listener: () => void) => () => void
  readonly canMutate: () => boolean
  readonly bootstrap: () => Promise<BootstrapState>
  readonly request: <T>(
    path: string,
    options: StudioRequestOptions,
    responseContract: StudioResponseContract<T>,
  ) => Promise<T>
}

export type StudioRequest = StudioHttpClientApi["request"]

export class StudioHttpClient implements StudioHttpClientApi {
  #csrfToken: string | undefined
  #sessionState: BootstrapState = { mode: "read-only-session" }
  readonly #sessionListeners = new Set<() => void>()

  readonly sessionSnapshot = (): BootstrapState => this.#sessionState

  readonly subscribeSession = (listener: () => void): (() => void) => {
    this.#sessionListeners.add(listener)
    return () => this.#sessionListeners.delete(listener)
  }

  #setSessionState(state: BootstrapState): void {
    if (
      this.#sessionState.mode === state.mode &&
      this.#sessionState.expiresAt === state.expiresAt
    ) {
      return
    }
    this.#sessionState = state
    for (const listener of this.#sessionListeners) listener()
  }

  #acceptSession(state: SessionState): BootstrapState {
    this.#csrfToken = state.csrf_token
    const bootstrap = { mode: "full", expiresAt: state.expires_at } as const
    this.#setSessionState(bootstrap)
    return bootstrap
  }

  #clearSessionAuthority(): void {
    this.#csrfToken = undefined
    this.#setSessionState({ mode: "read-only-session" })
  }

  readonly canMutate = (): boolean => {
    return this.#csrfToken !== undefined
  }

  readonly bootstrap = async (): Promise<BootstrapState> => {
    const capability = consumeLaunchCapability()
    if (capability !== undefined) {
      const state = await this.request(
        "/session/exchange",
        {
          method: "POST",
          body: { capability },
          csrf: "session-establishment",
        },
        studioResponseContracts.session,
      )
      return this.#acceptSession(state)
    }

    if (this.#csrfToken !== undefined) return this.#sessionState

    const state = await this.request(
      "/session/csrf",
      {
        method: "POST",
        body: {},
        csrf: "session-establishment",
      },
      studioResponseContracts.session,
    )
    return this.#acceptSession(state)
  }

  readonly request = async <T>(
    path: string,
    options: StudioRequestOptions,
    responseContract: StudioResponseContract<T>,
  ): Promise<T> => {
    const method = options.method ?? "GET"
    const headers = new Headers({ Accept: "application/json" })
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value)
    }

    if (options.body !== undefined || MUTATION_METHODS.has(method)) {
      headers.set("Content-Type", "application/json")
    }
    if (
      MUTATION_METHODS.has(method) &&
      options.csrf !== "session-establishment"
    ) {
      if (this.#csrfToken === undefined) {
        throw new StudioApiError({
          status: 403,
          code: "studio_csrf_unavailable",
          message:
            "A sessão foi restaurada apenas para leitura. Reabra a URL de inicialização para editar.",
        })
      }
      headers.set("X-Luna-CSRF", this.#csrfToken)
    }

    let response: Response
    try {
      response = await fetch(`${STUDIO_API_PREFIX}${path}`, {
        method,
        credentials: "same-origin",
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause
      throw new StudioApiError({
        status: 0,
        code: "studio_server_unreachable",
        message: "Não foi possível conectar ao servidor local do Luna Studio.",
      })
    }

    const text = await response.text()
    let payload: unknown
    if (text.length > 0) {
      try {
        payload = JSON.parse(text)
      } catch {
        throw new StudioApiError({
          status: response.status,
          code: "studio_response_invalid",
          message: "O servidor retornou uma resposta que o Studio não reconhece.",
        })
      }
    }

    if (!response.ok) {
      if (response.status === 401) this.#clearSessionAuthority()
      const envelope = parseErrorEnvelope(payload)
      if (envelope !== undefined) {
        throw new StudioApiError({
          status: response.status,
          code: envelope.error.code,
          message: envelope.error.message,
          requestId: envelope.error.request_id,
          details: envelope.error.details,
        })
      }
      throw new StudioApiError({
        status: response.status,
        code: "studio_request_failed",
        message: `A requisição ao Studio falhou com status ${response.status}.`,
      })
    }

    try {
      return responseContract.parse(payload)
    } catch {
      throw new StudioApiError({
        status: response.status,
        code: "studio_response_invalid",
        message: "O servidor retornou uma resposta que o Studio não reconhece.",
      })
    }
  }
}
