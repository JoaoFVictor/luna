import { matchesJsonSchema } from "../../core/capabilities/json-schema.js";
import { builtInError } from "../../core/built-ins/errors.js";
import { finalReportMetadata } from "../../core/built-ins/metadata.js";
import { defineBuiltInStep } from "../../core/built-ins/registry.js";
import {
  executionSummaryJson,
  executionSummaryMarkdownLines
} from "./execution-summary.js";
import type { ObservabilitySummary } from "../../core/observability/summary.js";

type ReportSection = {
  heading: string;
  content: unknown;
};

export const finalReportInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "content"],
        properties: {
          heading: { type: "string", minLength: 1 },
          content: { description: "Resolved report section content." }
        }
      }
    }
  }
} as const;

export const finalReportOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["report"],
  properties: {
    report: { type: "string" },
    execution: { type: "object" },
    artifact_refs: {
      type: "array",
      items: { type: "string" }
    }
  }
} as const;

function sectionContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function reportError(message: string): Error {
  return builtInError(message, "built_in_input_invalid");
}

function assertFinalReportOutput(output: unknown): void {
  if (!matchesJsonSchema(finalReportOutputSchema, output)) {
    throw builtInError(
      "Final report output did not match reports.final_report output schema",
      "built_in_output_invalid"
    );
  }
}

export function renderFinalReport(
  input: unknown,
  observabilitySummary?: ObservabilitySummary
): { report: string; execution?: ReturnType<typeof executionSummaryJson> } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw reportError("Final report input must be an object");
  }

  const record = input as { title?: unknown; sections?: unknown };
  if (!Array.isArray(record.sections)) {
    throw reportError("Final report input.sections must be an array");
  }

  const title = typeof record.title === "string" ? record.title : "Final Report";
  const sections = record.sections.map((section): ReportSection => {
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw reportError("Final report sections must be objects");
    }

    const candidate = section as { heading?: unknown; content?: unknown };
    if (typeof candidate.heading !== "string" || candidate.heading === "") {
      throw reportError("Final report section.heading must be a string");
    }

    return {
      heading: candidate.heading,
      content: candidate.content
    };
  });

  const execution = executionSummaryJson(observabilitySummary);
  const output = {
    report: [
      `# ${title}`,
      ...sections.flatMap((section) => [
        "",
        `## ${section.heading}`,
        "",
        sectionContent(section.content)
      ]),
      ...executionSummaryMarkdownLines(observabilitySummary)
    ].join("\n"),
    ...(execution === undefined ? {} : { execution })
  };
  assertFinalReportOutput(output);

  return output;
}

export const finalReportBuiltIn = defineBuiltInStep({
  name: "reports.final_report",
  metadata: finalReportMetadata,
  async run({ input, observabilitySummary }) {
    return renderFinalReport(input ?? {}, observabilitySummary);
  }
});
