export type LunaObservabilityLevel = "info" | "warn" | "error";

export type LunaObservabilityStatus =
  | "started"
  | "completed"
  | "failed"
  | "rejected"
  | "warning"
  | string;

export type LunaObservabilityEvent = {
  event: string;
  run_id: string;
  workflow_id: string;
  schema_version: 1;
  event_id: string;
  sequence: number;
  timestamp: string;
  level: LunaObservabilityLevel;
  flue_run_id?: string;
  run_attempt?: number;
  step_id?: string;
  node_type?: string;
  agent_id?: string;
  subagent_id?: string;
  prompt_id?: string;
  status?: LunaObservabilityStatus;
  duration_ms?: number;
  error?: unknown;
  attributes?: Record<string, unknown>;
};

export type LunaObservabilitySink = {
  id?: string;
  required?: boolean;
  append(event: LunaObservabilityEvent): Promise<void> | void;
};
