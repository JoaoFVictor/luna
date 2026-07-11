import { createBrowserRouter } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { RouteErrorPage } from "@/pages/error-page"

export const studioRouter = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import("@/pages/home-page")).HomePage }),
      },
      {
        path: "workflows",
        lazy: async () => ({ Component: (await import("@/pages/workflows-page")).WorkflowsPage }),
      },
      {
        path: "workflows/:workflowId",
        lazy: async () => ({ Component: (await import("@/pages/workflow-detail-page")).WorkflowDetailPage }),
      },
      {
        path: "workflows/:resourceId/history",
        lazy: async () => ({ Component: (await import("@/pages/resource-history-page")).WorkflowResourceHistoryPage }),
      },
      {
        path: "drafts/:draftId",
        lazy: async () => ({ Component: (await import("@/pages/workflow-editor-page")).WorkflowEditorPage }),
      },
      {
        path: "agent-drafts/:draftId",
        lazy: async () => ({ Component: (await import("@/pages/agent-editor-page")).AgentEditorPage }),
      },
      {
        path: "launch",
        lazy: async () => ({ Component: (await import("@/pages/launch-page")).LaunchPage }),
      },
      {
        path: "agents",
        lazy: async () => ({ Component: (await import("@/pages/agents-page")).AgentsPage }),
      },
      {
        path: "agents/:resourceId/history",
        lazy: async () => ({ Component: (await import("@/pages/resource-history-page")).AgentResourceHistoryPage }),
      },
      {
        path: "library",
        lazy: async () => ({ Component: (await import("@/pages/library-page")).LibraryPage }),
      },
      {
        path: "configuration",
        lazy: async () => ({ Component: (await import("@/pages/configuration-page")).ConfigurationPage }),
      },
      {
        path: "runs",
        lazy: async () => ({ Component: (await import("@/pages/runs-page")).RunsPage }),
      },
      {
        path: "runs/:runId",
        lazy: async () => ({ Component: (await import("@/pages/run-detail-page")).RunDetailPage }),
      },
      {
        path: "*",
        lazy: async () => ({ Component: (await import("@/pages/not-found-page")).NotFoundPage }),
      },
    ],
  },
])
