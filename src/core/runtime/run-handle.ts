import type { JsonObject } from "./json.js";

export type RunHandle = JsonObject & {
  run_id: string;
  workflow_id: string;
  attempt: number;
  started_at: string;
};
