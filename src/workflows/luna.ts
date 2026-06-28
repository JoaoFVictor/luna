import { loadNativeLunaPlatform } from "../platform/native/native-platform-loader.js";
import type {
  NativeWorkflowRunInput
} from "../runtime/composition/target-executor.js";

export async function run(input: NativeWorkflowRunInput): Promise<unknown> {
  const platform = await loadNativeLunaPlatform({
    projectRoot: input.projectRoot,
    configRoot: input.configRoot
  });

  return await platform.runWorkflow(input);
}
