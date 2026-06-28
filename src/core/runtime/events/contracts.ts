import type { JsonObject } from "../json.js";

export type RuntimeEvent = {
  id: string;
  run_id: string;
  sequence: number;
  type: string;
  timestamp: string;
  node_id?: string;
  interrupt_id?: string;
  resume_id?: string;
  data?: JsonObject;
};

export type RuntimeEventInput = Omit<RuntimeEvent, "sequence"> & {
  sequence?: number;
};

export type RuntimeEventQuery = {
  runId: string;
  nodeId?: string;
  interruptId?: string;
  resumeId?: string;
};

export type RuntimeEventStore = {
  append(event: RuntimeEventInput): Promise<RuntimeEvent>;
  list(runId: string): Promise<RuntimeEvent[]>;
  query(query: RuntimeEventQuery): Promise<RuntimeEvent[]>;
};
