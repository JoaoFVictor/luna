import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectNoSeriousAccessibilityViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
}

async function planInvocation(
  page: Page,
  invocation: Record<string, unknown>
): Promise<void> {
  await page.goto("/launch");
  await page.getByRole("tab", { name: "Invocation JSON" }).click();
  await page.getByRole("textbox", { name: "Invocation JSON" }).fill(
    JSON.stringify(invocation, null, 2)
  );
  await page.getByRole("button", {
    name: "Gerar plano autoritativo"
  }).click();
  await expect(page.getByText("Plano autoritativo", { exact: true }))
    .toBeVisible();
}

async function confirmAndExecutePlannedRun(page: Page): Promise<void> {
  await page.getByLabel("Confirmo um run real.").check();
  await page.getByLabel("Li os efeitos listados e as incertezas.").check();
  await page.getByRole("button", { name: "Executar run real" }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
}

test("boots a mutable local session without retaining its capability", async ({
  page
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", {
    name: "Construa, valide e aplique workflows Luna sem esconder os contratos."
  })).toBeVisible();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  await expect(
    page.getByText("Local single-user mode — no user identity or RBAC.")
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Workflows", exact: true })
  ).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("creates, refactors, compiles, applies and removes an isolated workflow draft", async ({
  page
}) => {
  const workflowId = `e2e-workflow-${Date.now()}`;
  await page.goto("/workflows");
  await page.getByRole("button", { name: "Novo workflow" }).click();
  await page.getByLabel("ID do workflow").fill(workflowId);
  await page.getByLabel("Template", { exact: true }).selectOption(
    "read-only-pipeline"
  );
  await page.getByRole("button", { name: "Criar draft" }).click();

  await expect(page.getByRole("heading", { name: workflowId })).toBeVisible();
  await page.getByRole("button", { name: "Compilar", exact: true }).click();
  await expect(page.getByText("Workflow compilado")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Design" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByText("preflight", { exact: true }).first()).toBeVisible();

  await page.getByLabel("ID", { exact: true }).fill("bootstrap");
  await page.getByRole("button", { name: "Revisar refactor" }).click();
  await expect(page.getByRole("heading", {
    name: `Renomear preflight para bootstrap?`
  })).toBeVisible();
  await expect(page.getByText("artifact source", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Aplicar refactor" }).click();
  await expect(page.getByText("bootstrap", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Compilar", exact: true }).click();
  await expect(page.getByText("Workflow compilado")).toBeVisible();
  await page.getByRole("button", { name: "Diff & apply" }).click();
  await expect(page.getByRole("heading", { name: "Plano de apply" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Aplicado em" }))
    .toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole("button", { name: "Remover draft" }).click();
  await page.getByRole("button", { name: "Remover draft", exact: true }).last().click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test("keeps the primary navigation keyboard reachable", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();

  await page.getByRole("button", { name: /Buscar/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("agents");
  await page.getByRole("option", { name: /Agents/ }).press("Enter");
  await expect(page).toHaveURL(/\/agents$/);
});

test("applies a reusable agent and compiles a workflow that references it", async ({
  page
}) => {
  const suffix = Date.now();
  const agentId = `e2e-agent-${suffix}`;
  const workflowId = `e2e-agent-workflow-${suffix}`;

  await page.goto("/agents?new=1");
  await expect(page.getByRole("heading", { name: "Novo agent reutilizável" }))
    .toBeVisible();
  await page.getByLabel("ID do agent").fill(agentId);
  await page.getByLabel("Model profile").selectOption("fast");
  await page.getByRole("button", { name: "Criar draft" }).click();
  await expect(page.getByRole("heading", { name: agentId })).toBeVisible();
  await page.getByRole("button", { name: "Validar" }).click();
  await expect(page.getByText("Agent válido")).toBeVisible();
  await page.getByRole("button", { name: "Diff & apply" }).click();
  await expect(page.getByRole("heading", { name: "Plano de apply" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Aplicado em" }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Test Bench" }).click();
  await expect(page.getByText("Test Bench do agent", { exact: true }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Gerar preview efetivo" }))
    .toBeEnabled();

  await page.goto("/workflows?new=1");
  await page.getByLabel("ID do workflow").fill(workflowId);
  await page.getByLabel("Template", { exact: true }).selectOption("agent-workflow");
  await page.getByLabel("Agent", { exact: true }).selectOption(agentId);
  await page.getByRole("button", { name: "Criar draft" }).click();
  await expect(page.getByRole("heading", { name: workflowId })).toBeVisible();
  await page.getByRole("button", { name: "Compilar", exact: true }).click();
  await expect(page.getByText("Workflow compilado")).toBeVisible();
  await expect(page.getByText("agent_task", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Diff & apply" }).click();
  await expect(page.getByRole("heading", { name: "Plano de apply" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmar apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Aplicado em" }))
    .toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole("button", { name: "Remover draft" }).click();
  await page.getByRole("button", { name: "Remover draft", exact: true }).last().click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test("keeps Launch accessible before any preview or real execution", async ({
  page
}) => {
  await page.goto("/launch");

  await expect(page.getByRole("heading", { name: "Launch" })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Adapter + string" })
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Gerar plano autoritativo" })
  ).toBeDisabled();
  await expect(page.getByText("Gerar o plano não inicia o workflow.")).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("previews, routes, plans and executes through a registered adapter", async ({
  page
}) => {
  await page.goto("/launch");
  await page.getByLabel("Adapter de origem").selectOption("studio-e2e.fixture");
  await page.getByLabel("String opaca / URL").fill("e2e-deterministic");
  await page.getByRole("button", {
    name: "Preview adapter + routing"
  }).click();

  await expect(page.getByRole("region", {
    name: "Preview não autoritativo do adapter"
  })).toBeVisible();
  await expect(page.getByText("Invocation projetada pelo preview", {
    exact: true
  })).toBeVisible();
  await expect(page.getByText("Campos redigidos: payload.", {
    exact: false
  })).toBeVisible();
  await expect(page.getByText("Target simulado: workflow:e2e-deterministic", {
    exact: true
  })).toBeVisible();

  await page.getByRole("button", {
    name: "Gerar plano autoritativo"
  }).click();
  await expect(page.getByText("Plano autoritativo", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(/adapter studio-e2e\.fixture/u)).toBeVisible();
  await confirmAndExecutePlannedRun(page);
  await expect(page.getByRole("heading", { name: "e2e-deterministic" }))
    .toBeVisible();
  await expect(page.getByText("Concluída", { exact: true })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByText("Accepted plan", { exact: true })).toBeVisible();
  await expect(page.getByText("Input provenance", { exact: true })).toBeVisible();
  await expect(page.getByText(/adapter studio-e2e\.fixture/u)).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("plans, confirms and explains a real deterministic run", async ({
  page
}) => {
  await planInvocation(page, {
    version: "2026-06",
    source: "studio-e2e",
    event: "manual",
    target: { type: "workflow", id: "e2e-deterministic" },
    payload: {}
  });

  await expect(page.getByText("e2e-deterministic", { exact: true }).first())
    .toBeVisible();
  await confirmAndExecutePlannedRun(page);
  await expect(page.getByRole("heading", { name: "e2e-deterministic" }))
    .toBeVisible();
  await expect(page.getByText("Concluída", { exact: true })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByText("e2e-result.json", { exact: true }))
    .toBeVisible();
  await expect(page.getByText(/deterministic Studio E2E/u))
    .toBeVisible();
  await expect(page.getByText("run.status.succeeded", { exact: true })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("diagnoses an exact failed node from the persisted run graph", async ({
  page
}) => {
  await planInvocation(page, {
    version: "2026-06",
    source: "studio-e2e",
    event: "manual",
    target: { type: "workflow", id: "e2e-failure" },
    payload: {}
  });
  await confirmAndExecutePlannedRun(page);

  await expect(page.getByRole("heading", { name: "e2e-failure" }))
    .toBeVisible();
  await expect(page.getByText("Falhou", { exact: true }).first()).toBeVisible({
    timeout: 15_000
  });
  await page.getByRole("tab", { name: "Outline acessível" }).click();
  await expect(page.getByRole("button", {
    name: /rejected_approval, hitl\.require_approval, Falhou, 1 tentativa, falha principal da execução/u
  })).toBeVisible();
  await expect(page.getByText("run.status.failed", { exact: true })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("confirms and executes trusted local write authority in an isolated repository", async ({
  page
}) => {
  await planInvocation(page, {
    version: "2026-06",
    source: "studio-e2e",
    event: "manual",
    target: { type: "workflow", id: "e2e-trusted-write" },
    repository: {
      provider: "github",
      owner: "studio-e2e",
      name: "fixture"
    },
    subject: {
      type: "task",
      id: "trusted-write-e2e",
      title: "Trusted write E2E"
    },
    payload: {}
  });

  await expect(page.getByText("trusted_local_write", { exact: true }))
    .toBeVisible();
  await confirmAndExecutePlannedRun(page);
  await expect(page.getByRole("heading", { name: "Trusted write E2E" }))
    .toBeVisible();
  await expect(page.getByText("Concluída", { exact: true })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByText("trusted-preflight.json", { exact: true }))
    .toBeVisible();
  await expect(page.getByText("studio-e2e-fixture", { exact: true }))
    .toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});
