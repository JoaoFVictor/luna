export function gatedAgentWorkerKey(patternNodeId: string): string {
  return `${patternNodeId}:worker`;
}

export function gatedAgentGateKey(patternNodeId: string, gateId: string): string {
  return `${patternNodeId}:gate:${gateId}`;
}
