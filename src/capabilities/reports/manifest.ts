import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  finalReportInputSchema,
  finalReportOutputSchema
} from "./final-report.js";

export const manifest = capabilityManifest({
  id: "reports",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "reports.final_report": {
      id: "reports.final_report",
      presentation: {
        title: "Gerar relatório final",
        summary: "Consolida os resultados anteriores em um artifact final.",
        category: "Resultados",
        tags: ["report", "artifact"]
      },
      input_schema: finalReportInputSchema,
      output_schema: finalReportOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Final workflow reports" }]
});
