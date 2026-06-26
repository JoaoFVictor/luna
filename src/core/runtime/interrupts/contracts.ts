import type { JsonObject, JsonValue } from "../json.js";
import type { RunHandle } from "../run-handle.js";

export type InterruptStatus = "pending" | "resuming" | "resolved" | "cancelled";

export type InterruptPayload = {
  interrupt_id: string;
  run: RunHandle;
  checkpoint_id: string;
  node_id: string;
  kind: string;
  prompt: string;
  decisions: JsonValue[];
  created_at: string;
  expires_at?: string;
};

export type ResumeInput = {
  interrupt_id: string;
  thread_id: string;
  checkpoint_id: string;
  decision: JsonValue;
  payload?: JsonObject;
  actor?: JsonObject;
};

export type InterruptResumeRecord = {
  interrupt_id: string;
  resume_id: string;
  input: ResumeInput;
  decision: JsonValue;
  payload?: JsonObject;
  actor?: JsonObject;
  created_at: string;
};

export type InterruptResumeResult = InterruptResumeRecord & {
  already_resumed: boolean;
};

export type InterruptRecord = {
  id: string;
  run_id: string;
  thread_id?: string;
  checkpoint_id?: string;
  node_id?: string;
  status: InterruptStatus;
  created_at: string;
  updated_at: string;
  payload?: InterruptPayload;
  payload_ref?: string;
  resume_attempt?: string;
  resume?: InterruptResumeRecord;
};

export type InterruptResumeClaim = {
  interrupt_id: string;
  resume_attempt: string;
  status: "claimed";
};

export type InterruptResumeDuplicate = {
  interrupt_id: string;
  resume_attempt: string;
  status: "duplicate";
  resume: InterruptResumeRecord;
};

export type InterruptResumeBeginResult =
  | InterruptResumeClaim
  | InterruptResumeDuplicate;

export type InterruptStore = {
  create(record: InterruptRecord): Promise<void>;
  get(id: string): Promise<InterruptRecord | undefined>;
  list(runId: string): Promise<InterruptRecord[]>;
  beginResume(
    id: string,
    resumeAttempt: string,
    input: ResumeInput
  ): Promise<InterruptResumeBeginResult>;
  completeResume(
    id: string,
    claim: InterruptResumeClaim,
    status: Extract<InterruptStatus, "resolved" | "cancelled">,
    resume?: InterruptResumeRecord
  ): Promise<void>;
};
