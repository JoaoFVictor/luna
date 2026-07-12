import {
  StudioCapabilityCatalogSchema,
  StudioCapabilityConsumerIndexSchema,
  type StudioCapabilityCatalog,
  type StudioCatalogConsumers
} from "../../contracts/capability-catalog.js";
import type { StudioAgentCatalog } from "../../contracts/catalog.js";
import type { StudioWorkflowCatalog } from "../../contracts/workflow-catalog.js";

type MutableConsumers = {
  readonly workflows: Set<string>;
  readonly agents: Set<string>;
};

function emptyConsumers(): MutableConsumers {
  return { workflows: new Set(), agents: new Set() };
}

function sortedConsumers(consumers: MutableConsumers): StudioCatalogConsumers {
  return {
    workflows: [...consumers.workflows].sort((left, right) =>
      left.localeCompare(right)
    ),
    agents: [...consumers.agents].sort((left, right) =>
      left.localeCompare(right)
    )
  };
}

export function withStudioCapabilityConsumers(options: {
  readonly catalog: StudioCapabilityCatalog;
  readonly workflows: StudioWorkflowCatalog;
  readonly agents: StudioAgentCatalog;
}): StudioCapabilityCatalog {
  const capabilityConsumers = new Map<string, MutableConsumers>(
    options.catalog.capabilities.map(({ id }) => [id, emptyConsumers()])
  );
  const registrationConsumers = new Map<string, MutableConsumers>(
    options.catalog.registrations.map(({ id }) => [id, emptyConsumers()])
  );
  const registrationOwners = new Map(
    options.catalog.registrations.map((registration) => [
      registration.id,
      registration.owner.capability_id
    ])
  );

  const addRegistrationConsumer = (
    registrationId: string,
    kind: "workflows" | "agents",
    consumerId: string
  ) => {
    registrationConsumers.get(registrationId)?.[kind].add(consumerId);
    const owner = registrationOwners.get(registrationId);
    if (owner !== undefined) {
      capabilityConsumers.get(owner)?.[kind].add(consumerId);
    }
  };

  for (const workflow of options.workflows.workflows) {
    for (const capabilityId of workflow.capabilities) {
      capabilityConsumers.get(capabilityId)?.workflows.add(workflow.id);
    }
    for (const registrationId of workflow.registrations) {
      addRegistrationConsumer(registrationId, "workflows", workflow.id);
    }
  }

  for (const agent of options.agents.agents) {
    for (const registrationId of [
      agent.output_schema_reference,
      ...agent.tools
    ]) {
      addRegistrationConsumer(registrationId, "agents", agent.id);
    }
  }

  const incompleteSources = [
    ...(options.workflows.status === "partial" ? ["workflows" as const] : []),
    ...(options.agents.status === "partial" ? ["agents" as const] : [])
  ];
  const consumers = StudioCapabilityConsumerIndexSchema.parse({
    status: incompleteSources.length === 0 ? "complete" : "partial",
    incomplete_sources: incompleteSources,
    capabilities: Object.fromEntries(
      [...capabilityConsumers].map(([id, value]) => [id, sortedConsumers(value)])
    ),
    registrations: Object.fromEntries(
      [...registrationConsumers].map(([id, value]) => [id, sortedConsumers(value)])
    )
  });

  return StudioCapabilityCatalogSchema.parse({
    ...options.catalog,
    consumers
  });
}
