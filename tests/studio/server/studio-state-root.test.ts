import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStudioStateRootOutsideProject,
  studioProjectStateRoot
} from "../../../src/studio/server/studio-state-root.js";

describe("Studio private state root", () => {
  it("places project-scoped state outside the repository by default", () => {
    const projectRoot = path.resolve("/work/repository");
    const stateRoot = studioProjectStateRoot(projectRoot, {}, "/home/luna");

    expect(stateRoot).toMatch(
      /^\/home\/luna\/\.local\/state\/luna\/studio\/[a-f0-9]{64}$/u
    );
    expect(stateRoot.startsWith(`${projectRoot}${path.sep}`)).toBe(false);
  });

  it("uses an operator-owned override while retaining project isolation", () => {
    const stateRoot = studioProjectStateRoot(
      "/work/repository",
      { LUNA_STUDIO_STATE_ROOT: "/var/lib/luna-studio" },
      "/ignored"
    );

    expect(stateRoot).toMatch(
      /^\/var\/lib\/luna-studio\/[a-f0-9]{64}$/u
    );
  });

  it("isolates two host checkout identities inside the same volume", () => {
    const sharedEnvironment = {
      LUNA_STUDIO_CONTAINER_MODE: "1",
      LUNA_STUDIO_STATE_ROOT: "/var/lib/luna-studio"
    } as const;
    const first = studioProjectStateRoot("/app", {
      ...sharedEnvironment,
      LUNA_STUDIO_CHECKOUT_ID: "0123456789abcdef"
    });
    const second = studioProjectStateRoot("/app", {
      ...sharedEnvironment,
      LUNA_STUDIO_CHECKOUT_ID: "fedcba9876543210"
    });

    expect(path.dirname(first)).toBe("/var/lib/luna-studio");
    expect(path.dirname(second)).toBe("/var/lib/luna-studio");
    expect(first).not.toBe(second);
  });

  it("requires an explicit valid checkout identity in container mode", () => {
    expect(() => studioProjectStateRoot("/app", {
      LUNA_STUDIO_CONTAINER_MODE: "1",
      LUNA_STUDIO_STATE_ROOT: "/var/lib/luna-studio"
    })).toThrow("LUNA_STUDIO_CHECKOUT_ID is required");
    expect(() => studioProjectStateRoot("/app", {
      LUNA_STUDIO_CHECKOUT_ID: "checkout"
    })).toThrow("must be 16-48");
  });

  it("rejects an override inside the project checkout", () => {
    expect(() => assertStudioStateRootOutsideProject(
      "/work/repository",
      "/work/repository/.luna/studio-state"
    )).toThrow("outside the project checkout");
  });
});
