import jsonata from "jsonata";

function isWorkflowExpression(value: unknown): value is { expression: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { expression?: unknown }).expression === "string"
  );
}

async function resolveGateInputValue(
  value: unknown,
  context: Record<string, unknown>
): Promise<unknown> {
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map(async (item) => await resolveGateInputValue(item, context))
    );
  }

  if (isWorkflowExpression(value)) {
    return await jsonata(value.expression).evaluate(context);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, item]) => [
          key,
          await resolveGateInputValue(item, context)
        ])
      )
    );
  }

  return value;
}

export async function resolveGateInput(
  input: Record<string, unknown> | undefined,
  context: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return (await resolveGateInputValue(input ?? {}, context)) as Record<
    string,
    unknown
  >;
}
