export type InterruptStatus = "pending" | "resuming" | "resolved" | "cancelled";

export type InterruptRecord = {
  id: string;
  run_id: string;
  node_id?: string;
  status: InterruptStatus;
  created_at: string;
  updated_at: string;
  payload_ref?: string;
  resume_attempt?: string;
};

export type InterruptResumeClaim = {
  interrupt_id: string;
  resume_attempt: string;
};

export type InterruptStore = {
  create(record: InterruptRecord): Promise<void>;
  get(id: string): Promise<InterruptRecord | undefined>;
  list(runId: string): Promise<InterruptRecord[]>;
  beginResume(id: string, resumeAttempt: string): Promise<InterruptResumeClaim>;
  completeResume(id: string, status: Extract<InterruptStatus, "resolved" | "cancelled">): Promise<void>;
};
