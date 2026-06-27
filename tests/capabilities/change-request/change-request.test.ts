import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createChangeRequestCreateBuiltIn,
  changeRequestPortsFromBuiltInOptions
} from "../../../src/capabilities/change-request/built-ins.js";
import type {
  ChangeRequestProviderFactory,
  ChangeRequestProviderPort
} from "../../../src/capabilities/change-request/contracts.js";
import { manifest } from "../../../src/capabilities/change-request/manifest.js";
import { createChangeRequestProviderRegistry } from "../../../src/capabilities/change-request/provider-registry.js";
import { createCapabilityRegistry } from "../../../src/core/capabilities/registry.js";

const state = {
  invocation: {},
  run: { run_id: "run-1" },
  workflow: { id: "workflow-1", mode: "trusted_local_write" },
  steps: {}
};

async function listTypeScriptFiles(relativeDirectory: string): Promise<string[]> {
  const entries = await readdir(relativeDirectory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return await listTypeScriptFiles(relativePath);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
    })
  );

  return files.flat().sort();
}

function factoryFor(port: ChangeRequestProviderPort): ChangeRequestProviderFactory {
  return {
    provider_id: port.provider_id,
    createProvider: () => port
  };
}

describe("change-request capability", () => {
  it("declares provider-neutral create operation with retry adoption policy", () => {
    const registry = createCapabilityRegistry([manifest]);
    const changeRequest = registry.get("change-request");

    expect(changeRequest.ports?.["change-request.provider"]).toMatchObject({
      id: "change-request.provider",
      capability: "change-request"
    });
    expect(changeRequest.built_ins?.["change-request.create"]).toMatchObject({
      id: "change-request.create",
      required_ports: ["change-request.provider"],
      side_effect_policy: "change-request.create_side_effect"
    });
    expect(
      changeRequest.policies?.["change-request.create_side_effect"]
    ).toMatchObject({
      side_effect_semantics: "write",
      side_effect_operation_ids: ["change-request.create"],
      idempotency_scope: "attempt",
      retry_semantics: "retry_requires_adoption"
    });
  });

  it("registers provider-owned factories through an explicit neutral registry", () => {
    const provider: ChangeRequestProviderPort = {
      provider_id: "example",
      readChangeRequest: vi.fn(),
      createChangeRequest: vi.fn()
    };
    const factory = factoryFor(provider);
    const registry = createChangeRequestProviderRegistry([factory]);

    expect(registry.get("example")).toBe(provider);
    expect(() => registry.get("missing")).toThrow(
      "Unsupported change request provider: missing"
    );
  });

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
    ).resolves.toEqual({
      operation_id: "change-request.create",
      enabled: true,
      skipped: false,
      provider: "example",
      provider_id: "example",
      external_id: "cr-42",
      url: "https://example.test/change/cr-42",
      title: "Implement thing",
      source_branch: "task/run-1",
      target_branch: "main",
      adopted: true
    });
    expect(readChangeRequest).toHaveBeenCalledWith({
      operation_id: "change-request.create",
      enabled: true,
      provider_id: "example",
      repository_path: "/repo/workspace",
      title: "Implement thing",
      source_branch: "task/run-1",
      target_branch: "main"
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

  it("resolves ports from runtime dependencies without a default provider import", () => {
    const providers = createChangeRequestProviderRegistry([]);

    expect(
      changeRequestPortsFromBuiltInOptions({
        state,
        dependencies: { changeRequest: { providers } }
      })
    ).toEqual({ providers });
  });

  it("keeps generic change-request leaves free of provider schema leakage", async () => {
    const genericFiles = [
      "src/capabilities/change-request/manifest.ts",
      "src/capabilities/change-request/contracts.ts",
      "src/capabilities/change-request/built-ins.ts",
      "src/capabilities/change-request/provider-registry.ts"
    ];

    for (const file of genericFiles) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/GitHub|github|Plane|plane|Jira|jira/);
      expect(source).not.toMatch(/src\/providers|core\/providers/);
      expect(source).not.toMatch(/change-request-actions/);
    }
  });

  it("keeps provider-owned change request adapters under the single provider root", async () => {
    const providerFiles = await listTypeScriptFiles("src/providers");
    const changeRequestProviderFiles = providerFiles.filter((file) =>
      file.includes("/change-request/")
    );

    expect(changeRequestProviderFiles).toContain(
      "src/providers/github/change-request/factory.ts"
    );

    const coreFiles = await listTypeScriptFiles("src/core");
    for (const file of coreFiles) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/providers\/[^"']+\/change-request/);
      expect(source).not.toMatch(/change-request-actions/);
    }
  });
});
