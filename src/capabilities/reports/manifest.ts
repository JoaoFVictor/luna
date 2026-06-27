import { capabilityManifest } from "../../core/capabilities/manifest.js";
import {
  finalReportInputSchema,
  finalReportOutputSchema
} from "../../core/reports/final-report.js";

export const manifest = capabilityManifest({
  id: "reports",
  kind: "execution",
  version: "2026.06.25",
  built_ins: {
    "reports.final_report": {
      id: "reports.final_report",
      input_schema: finalReportInputSchema,
      output_schema: finalReportOutputSchema,
      required_ports: []
    }
  },
  docs: [{ title: "Final workflow reports" }]
});
