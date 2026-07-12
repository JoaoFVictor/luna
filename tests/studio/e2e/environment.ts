import path from "node:path";

export const e2ePort = Number.parseInt(
  process.env.LUNA_STUDIO_E2E_PORT ?? "43219",
  10
);
export const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
export const e2eStateFile = path.join(
  "/tmp",
  `luna-studio-e2e-state-${e2ePort}.json`
);
export const e2eBootstrapFile = path.join(
  "/tmp",
  `luna-studio-e2e-bootstrap-${e2ePort}.json`
);
