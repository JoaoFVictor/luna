import type { FlueContext } from "@flue/runtime";
import type { ConfiguredWorkflowResult } from "../core/configured-workflow-runner.js";
import type { Invocation } from "../core/types.js";
import { runWithFlue } from "./luna.js";

export async function run(
  ctx: FlueContext<Invocation>
): Promise<ConfiguredWorkflowResult> {
  return await runWithFlue(ctx, { defaultWorkflowId: "code-review" });
}
