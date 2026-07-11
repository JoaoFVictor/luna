import { readFile } from "node:fs/promises";
import { chromium, type FullConfig } from "@playwright/test";

import { e2eBootstrapFile, e2eStateFile } from "./environment.js";

type BootstrapRecord = { readonly launchUrl: string };

async function readBootstrapRecord(): Promise<BootstrapRecord> {
  const deadline = Date.now() + 10_000;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(
        await readFile(e2eBootstrapFile, "utf8")
      ) as BootstrapRecord;
      if (typeof record.launchUrl === "string" && record.launchUrl.length > 0) {
        return record;
      }
    } catch (cause) {
      lastFailure = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The Studio E2E bootstrap URL was not published", {
    cause: lastFailure
  });
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const project = config.projects[0];
  if (project === undefined) {
    throw new Error("The Studio E2E suite requires a browser project");
  }
  const { launchUrl } = await readBootstrapRecord();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: project.use.baseURL });
    const page = await context.newPage();
    await page.goto(launchUrl);
    await page.getByRole("heading", {
      name: "Construa, valide e aplique workflows Luna sem esconder os contratos."
    }).waitFor();
    if (new URL(page.url()).hash !== "") {
      throw new Error("The one-time Studio capability remained in browser history");
    }
    await context.storageState({ path: e2eStateFile });
    await context.close();
  } finally {
    await browser.close();
  }
}
