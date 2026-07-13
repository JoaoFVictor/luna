export function workflowLoopBodyNodeKey(
  loopNodeId: string,
  bodyNodeId: string
): string {
  return `${loopNodeId}.${bodyNodeId}`;
}

export type LoopBodyOccurrenceIdentity = {
  readonly loop_node_id: string;
  readonly body_node_id: string;
  readonly iteration: number;
};

const LOOP_OCCURRENCE_ID = /^([^:]+):iteration-([1-9][0-9]*):([^:]+)$/u;

export function loopBodyOccurrenceNodeId(
  identity: LoopBodyOccurrenceIdentity
): string {
  return `${identity.loop_node_id}:iteration-${identity.iteration}:${identity.body_node_id}`;
}

export function parseLoopBodyOccurrenceNodeId(
  nodeId: string
): LoopBodyOccurrenceIdentity | undefined {
  const match = LOOP_OCCURRENCE_ID.exec(nodeId);
  if (match === null) return undefined;
  const iteration = Number(match[2]);
  if (!Number.isSafeInteger(iteration)) return undefined;
  return {
    loop_node_id: match[1]!,
    body_node_id: match[3]!,
    iteration
  };
}

export function workflowLoopBodyEffectNodeId(
  loopNodeId: string,
  bodyNodeId: string
): string {
  return [loopNodeId, bodyNodeId].map(encodeURIComponent).join("/");
}

export function workflowEffectNodeMatchesExecutionNode(
  effectNodeId: string,
  executionNodeId: string
): boolean {
  if (effectNodeId === executionNodeId) return true;
  const occurrence = parseLoopBodyOccurrenceNodeId(executionNodeId);
  if (occurrence !== undefined) {
    return effectNodeId === workflowLoopBodyEffectNodeId(
      occurrence.loop_node_id,
      occurrence.body_node_id
    );
  }
  const patternOccurrence = parsePatternStageOccurrenceNodeId(executionNodeId);
  return patternOccurrence !== undefined &&
    effectNodeId === workflowPatternStageEffectNodeId(
      patternOccurrence.pattern_node_id,
      patternOccurrence.stage_id
    );
}

export type PatternStageOccurrenceIdentity = {
  readonly pattern_node_id: string;
  readonly attempt: number;
  readonly stage_id: string;
};

const PATTERN_OCCURRENCE_ID = /^([^:]+):attempt-([1-9][0-9]*):stage-(.+)$/u;

export function patternStageOccurrenceNodeId(
  identity: PatternStageOccurrenceIdentity
): string {
  return `${identity.pattern_node_id}:attempt-${identity.attempt}:stage-${identity.stage_id}`;
}

export function parsePatternStageOccurrenceNodeId(
  nodeId: string
): PatternStageOccurrenceIdentity | undefined {
  const match = PATTERN_OCCURRENCE_ID.exec(nodeId);
  if (match === null) return undefined;
  const attempt = Number(match[2]);
  if (!Number.isSafeInteger(attempt)) return undefined;
  const stageId = match[3]!;
  if (stageId.length === 0) return undefined;
  return {
    pattern_node_id: match[1]!,
    attempt,
    stage_id: stageId
  };
}

export function workflowPatternStageEffectNodeId(
  patternNodeId: string,
  stageId: string
): string {
  return ["pattern", patternNodeId, stageId].join("/");
}
