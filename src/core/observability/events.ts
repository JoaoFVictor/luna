import {
  assertJsonValue,
  type JsonValue
} from "../json/value.js";

export type JsonObject = { [key: string]: JsonValue };

export type LunaEventStatus = "started" | "succeeded" | "failed" | "skipped";

export type LunaStepType = "built_in" | "agent" | "gated_agent_loop";

export type LunaEvent = {
  type: string;
  severity: LunaObservabilityLevel;
  timestamp: string;
  run: {
    id: string;
    runtimeRunId?: string;
    attempt: number;
  };
  workflow: {
    id: string;
  };
  step?: {
    id: string;
    type: LunaStepType;
  };
  outcome?: {
    status: LunaEventStatus;
    code?: string;
  };
  data?: JsonObject;
};

export type LunaObservabilityLevel = "info" | "warn" | "error";

export type LunaObservabilitySink = {
  id?: string;
  required?: boolean;
  append(event: LunaEvent): Promise<void> | void;
};

type EventContext = {
  severity: LunaObservabilityLevel;
  run: LunaEvent["run"];
  workflow: LunaEvent["workflow"];
  timestamp: string;
  data?: JsonObject;
};

type StepEventContext = EventContext & {
  step: NonNullable<LunaEvent["step"]>;
};

type RunCompletedContext = EventContext & {
  status: Extract<LunaEventStatus, "succeeded" | "failed">;
  code?: string;
};

type StepFailedContext = StepEventContext & {
  code?: string;
};

function eventData(data: JsonObject | undefined): { data?: JsonObject } {
  if (data === undefined || Object.keys(data).length === 0) {
    return {};
  }

  assertJsonValue(data, "$.data");
  return { data };
}

function eventRun(run: LunaEvent["run"]): LunaEvent["run"] {
  return {
    id: run.id,
    ...(run.runtimeRunId === undefined ? {} : { runtimeRunId: run.runtimeRunId }),
    attempt: run.attempt
  };
}

function eventOutcome(
  status: LunaEventStatus,
  code?: string
): LunaEvent["outcome"] {
  return {
    status,
    ...(code === undefined ? {} : { code })
  };
}

function eventBase(context: EventContext): Omit<LunaEvent, "type"> {
  return {
    severity: context.severity,
    timestamp: context.timestamp,
    run: eventRun(context.run),
    workflow: context.workflow,
    ...eventData(context.data)
  };
}

export function runStartedEvent(context: EventContext): LunaEvent {
  return {
    type: "luna.run.started",
    ...eventBase(context),
    outcome: eventOutcome("started")
  };
}

export function stepStartedEvent(context: StepEventContext): LunaEvent {
  return {
    type: "luna.step.started",
    ...eventBase(context),
    step: context.step,
    outcome: eventOutcome("started")
  };
}

export function stepSucceededEvent(context: StepEventContext): LunaEvent {
  return {
    type: "luna.step.succeeded",
    ...eventBase(context),
    step: context.step,
    outcome: eventOutcome("succeeded")
  };
}

export function stepFailedEvent(context: StepFailedContext): LunaEvent {
  return {
    type: "luna.step.failed",
    ...eventBase(context),
    step: context.step,
    outcome: eventOutcome("failed", context.code)
  };
}

export function stepSkippedEvent(context: StepFailedContext): LunaEvent {
  return {
    type: "luna.step.skipped",
    ...eventBase(context),
    step: context.step,
    outcome: eventOutcome("skipped", context.code)
  };
}

export function runCompletedEvent(context: RunCompletedContext): LunaEvent {
  return {
    type: "luna.run.completed",
    ...eventBase(context),
    outcome: eventOutcome(context.status, context.code)
  };
}

export function customEvent({
  type,
  outcome,
  step,
  ...context
}: EventContext & {
  type: string;
  outcome?: LunaEvent["outcome"];
  step?: LunaEvent["step"];
}): LunaEvent {
  return {
    type,
    ...eventBase(context),
    ...(step === undefined ? {} : { step }),
    ...(outcome === undefined ? {} : { outcome })
  };
}
