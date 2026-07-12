import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeLunaPlatformRegistrations } from "../../../src/platform/native/native-platform-registrations.js";
import {
  createNativeStudioAuthoringServices,
  requireStudioApplyRecovery,
  StudioApplyRecoveryStartupError
} from "../../../src/studio/server/native-authoring-services.js";

describe("native Studio authoring services", () => {
  it("composes one shared draft/validation/apply authority and initializes once", async () => {
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), "luna-studio-authoring-")
    );
    const configRoot = path.join(projectRoot, "config");
    await mkdir(configRoot);
    const services = createNativeStudioAuthoringServices({
      projectRoot,
      configRoot,
      platform: nativeLunaPlatformRegistrations,
      technicalCatalogFingerprint: () =>
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    const recover = vi.spyOn(services.apply, "recover");

    await expect(
      Promise.all([services.initialize(), services.initialize()])
    ).resolves.toEqual([undefined, undefined]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(services.drafts).toBeDefined();
    expect(services.validation).toBeDefined();
  });

  it("fails startup when any durable apply operation still needs recovery", async () => {
    const recover = vi.fn(async () => ({
      recovered: ["recovered-operation"],
      committed: [],
      recoveryRequired: ["unsafe-operation"]
    }));

    await expect(requireStudioApplyRecovery({ recover })).rejects.toEqual(
      expect.objectContaining<Partial<StudioApplyRecoveryStartupError>>({
        code: "studio_apply_recovery_incomplete",
        operationIds: ["unsafe-operation"]
      })
    );
  });
});
