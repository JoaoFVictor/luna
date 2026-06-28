import { describe, expect, it, vi } from "vitest";
import {
  createChangeRequestCreateBuiltIn
} from "../../../src/capabilities/change-request/built-ins.js";
import type {
  ChangeRequestProviderFactory,
  ChangeRequestProviderPort
} from "../../../src/capabilities/change-request/contracts.js";
import { createChangeRequestProviderRegistry } from "../../../src/capabilities/change-request/provider-registry.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "workflow-1", mode: "trusted_local_write" },
  steps: {}
};

function factoryFor(port: ChangeRequestProviderPort): ChangeRequestProviderFactory {
  return {
    provider_id: port.provider_id,
    createProvider: () => port
  };
}

describe("change-request capability", () => {
  it("reads external change request state and adopts compatible prior results", async () => {
    const readChangeRequest = vi.fn<
      ChangeRequestProviderPort["readChangeRequest"]
    >(async () => ({
      operation_id: "change-request.create",
      enabled: true,
      skipped: false,
      provider: "example",
      provider_id: "example",
      external_id: "cr-42",
      url: "https://example.test/change/cr-42",
      title: "Implement thing",
      source_branch: "task/run-1",
      target_branch: "main"
    }));
    const createChangeRequest = vi.fn<
      ChangeRequestProviderPort["createChangeRequest"]
    >(async () => {
      throw new Error("create should not run when adoption succeeds");
    });
    const provider: ChangeRequestProviderPort = {
      provider_id: "example",
      readChangeRequest,
      createChangeRequest
    };
    const builtIn = createChangeRequestCreateBuiltIn({
      providers: createChangeRequestProviderRegistry([factoryFor(provider)])
    });

    await expect(
      builtIn.run({
        state,
        input: {
          provider_id: "example",
          repository_path: "/repo/workspace",
          title: "Implement thing",
          source_branch: "task/run-1",
          target_branch: "main"
        }
      })
    ).resolves.toMatchObject({
      external_id: "cr-42",
      adopted: true
    });
    expect(createChangeRequest).not.toHaveBeenCalled();
  });

  it("creates only after read-before-write finds no compatible external request", async () => {
    const provider: ChangeRequestProviderPort = {
      provider_id: "example",
      readChangeRequest: vi.fn(async () => undefined),
      createChangeRequest: vi.fn<
        ChangeRequestProviderPort["createChangeRequest"]
      >(async () => ({
        operation_id: "change-request.create",
        enabled: true,
        skipped: false,
        provider: "example",
        provider_id: "example",
        external_id: "cr-43",
        url: "https://example.test/change/cr-43",
        title: "Implement thing",
        source_branch: "task/run-1",
        target_branch: "main",
        adopted: false
      }))
    };
    const builtIn = createChangeRequestCreateBuiltIn({
      providers: createChangeRequestProviderRegistry([factoryFor(provider)])
    });

    await expect(
      builtIn.run({
        state,
        input: {
          provider_id: "example",
          repository_path: "/repo/workspace",
          title: "Implement thing",
          source_branch: "task/run-1",
          target_branch: "main"
        }
      })
    ).resolves.toMatchObject({
      external_id: "cr-43",
      adopted: false
    });
    expect(provider.readChangeRequest).toHaveBeenCalledBefore(
      provider.createChangeRequest as ReturnType<typeof vi.fn>
    );
  });

  it("adopts compatible external state when create fails after the side effect", async () => {
    const readChangeRequest = vi.fn<
      ChangeRequestProviderPort["readChangeRequest"]
    >()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        operation_id: "change-request.create",
        provider_id: "example",
        external_id: "cr-44",
        url: "https://example.test/change/cr-44",
        title: "Implement thing",
        source_branch: "task/run-1",
        target_branch: "main"
      });
    const provider: ChangeRequestProviderPort = {
      provider_id: "example",
      readChangeRequest,
      createChangeRequest: vi.fn(async () => {
        throw new Error("create returned non-zero after creating the change request");
      })
    };
    const builtIn = createChangeRequestCreateBuiltIn({
      providers: createChangeRequestProviderRegistry([factoryFor(provider)])
    });

    await expect(
      builtIn.run({
        state,
        input: {
          provider_id: "example",
          repository_path: "/repo/workspace",
          title: "Implement thing",
          source_branch: "task/run-1",
          target_branch: "main"
        }
      })
    ).resolves.toMatchObject({
      operation_id: "change-request.create",
      external_id: "cr-44",
      adopted: true
    });
    expect(readChangeRequest).toHaveBeenCalledTimes(2);
  });

});
