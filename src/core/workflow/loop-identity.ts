export function workflowLoopBodyNodeKey(
  loopNodeId: string,
  bodyNodeId: string
): string {
  return `${loopNodeId}.${bodyNodeId}`;
}
