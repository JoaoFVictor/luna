import { patternWorkerKey } from "../agents/pattern-agent-runner.js";

export function gatedAgentWorkerKey(patternNodeId: string): string {
  return patternWorkerKey(patternNodeId);
}

export function gatedAgentGateKey(patternNodeId: string, gateId: string): string {
  return `${patternNodeId}:gate:${gateId}`;
}
