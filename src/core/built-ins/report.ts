import { resolveWorkflowInput, type WorkflowState } from "../workflow/state.js";
import { builtInError } from "./errors.js";
import { defineBuiltInStep } from "./registry.js";
import { finalReportMetadata } from "./metadata.js";

type ReportSection = {
  heading: string;
  content: unknown;
};

function resolveValue(value: unknown, state: WorkflowState): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, state));
  }

  if (typeof value === "string" && value.startsWith("$.")) {
    return resolveWorkflowInput({ value }, state).value;
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, state)])
    );
  }

  return value;
}

function sectionContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function reportError(message: string): Error {
  return builtInError(message, "built_in_input_invalid");
}

export const finalReportBuiltIn = defineBuiltInStep({
  name: "final_report",
  metadata: finalReportMetadata,
  async run({ state, input }) {
    const resolved = resolveValue(input ?? {}, state);

    if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
      throw reportError("Final report input must be an object");
    }

    const record = resolved as { title?: unknown; sections?: unknown };
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

    const report = [
      `# ${title}`,
      ...sections.flatMap((section) => [
        "",
        `## ${section.heading}`,
        "",
        sectionContent(section.content)
      ])
    ].join("\n");

    return { report };
  }
});
