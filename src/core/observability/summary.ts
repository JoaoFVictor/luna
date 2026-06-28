export type TraceSummaryPublisher = {
  publish(input: {
    readonly node_id: string;
    readonly path: string;
    readonly format: "json";
    readonly value: unknown;
    readonly overwrite_policy: "replace";
  }): Promise<unknown>;
};

export async function writeTraceSummaryBestEffort(
  publisher: TraceSummaryPublisher | undefined,
  summary: unknown | undefined
): Promise<boolean> {
  if (publisher === undefined || summary === undefined) {
    return false;
  }

  try {
    await publisher.publish({
      node_id: "observability",
      path: "observability-summary.json",
      format: "json",
      value: summary,
      overwrite_policy: "replace"
    });
    return true;
  } catch {
    return false;
  }
}
