import { useQuery } from "@tanstack/react-query"
import { Fragment, useEffect, useRef } from "react"
import {
  BotIcon,
  BoxesIcon,
  CircleIcon,
  CommandIcon,
  HouseIcon,
  NetworkIcon,
  RocketIcon,
  PlayIcon,
  SearchIcon,
  Settings2Icon,
  ShieldAlertIcon,
} from "lucide-react"
import { Link, NavLink, Outlet, useLocation } from "react-router-dom"

import { draftsQuery } from "@/api/queries"
import { useEditorState, useStudioSession } from "@/app/studio-context"
import { CommandPalette } from "@/components/command-palette"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { useCommandPaletteShortcut } from "@/hooks/use-command-palette-shortcut"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"

const navigation = [
  { label: "Início", to: "/", icon: HouseIcon },
  { label: "Workflows", to: "/workflows", icon: NetworkIcon },
  { label: "Launch", to: "/launch", icon: RocketIcon },
  { label: "Agents", to: "/agents", icon: BotIcon },
  { label: "Library", to: "/library", icon: BoxesIcon },
  { label: "Configuration", to: "/configuration", icon: Settings2Icon },
  { label: "Runs", to: "/runs", icon: PlayIcon },
] as const

const segmentLabels: Record<string, string> = {
  workflows: "Workflows",
  launch: "Launch",
  drafts: "Draft",
  agents: "Agents",
  library: "Library",
  configuration: "Configuration",
  runs: "Runs",
}

function AppBreadcrumbs() {
  const location = useLocation()
  const segments = location.pathname.split("/").filter(Boolean)
  if (segments.length === 0) return <span className="text-sm font-medium">Início</span>

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link to="/" />}>Início</BreadcrumbLink>
        </BreadcrumbItem>
        {segments.map((segment, index) => {
          const path = `/${segments.slice(0, index + 1).join("/")}`
          const isLast = index === segments.length - 1
          const label = segmentLabels[segment] ?? (segment.length > 24 ? `${segment.slice(0, 8)}…` : segment)
          return (
            <Fragment key={path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link to={path} />}>{label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

export function AppShell() {
  const location = useLocation()
  const session = useStudioSession()
  const editorState = useEditorState()
  const drafts = useQuery(draftsQuery)
  const [paletteOpen, setPaletteOpen] = useCommandPaletteShortcut()
  const draftCount = drafts.data?.items.length ?? 0
  const mainRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true })
  }, [location.pathname])

  return (
    <SidebarProvider>
      <a
        href="#studio-main"
        className="fixed top-2 left-2 z-50 -translate-y-20 rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:translate-y-0"
      >
        Ir para o conteúdo principal
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link to="/" />} tooltip="Luna Studio">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <CommandIcon aria-hidden="true" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Luna Studio</span>
                  <span className="truncate text-xs text-muted-foreground">Projeto local</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Studio</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navigation.map((item) => {
                  const active =
                    item.to === "/"
                      ? location.pathname === "/"
                      : location.pathname.startsWith(item.to)
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.label}
                        render={<NavLink to={item.to} />}
                      >
                        <item.icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-2 rounded-lg border p-2 text-xs group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0">
            <CircleIcon className="size-2 fill-emerald-500 text-emerald-500" aria-hidden="true" />
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate font-medium">Sessão local inicializada</p>
              <p className="truncate text-muted-foreground">
                {session.canMutate ? "Sessão de autoria" : "Sessão somente leitura"}
              </p>
            </div>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-h-svh overflow-hidden">
        <div className="flex min-h-11 items-center gap-3 border-b px-3 sm:px-4">
          <SidebarTrigger />
          <div className="min-w-0 flex-1"><AppBreadcrumbs /></div>
          {editorState.hasLocalChanges && (
            <Badge variant="destructive" className="hidden sm:inline-flex">Não salvo</Badge>
          )}
          {draftCount > 0 && (
            <Badge variant="outline" className="hidden sm:inline-flex">
              {draftCount} {draftCount === 1 ? "draft" : "drafts"}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => setPaletteOpen(true)}>
            <SearchIcon aria-hidden="true" />
            <span className="hidden sm:inline">Buscar</span>
            <Kbd className="ml-1 hidden lg:inline-flex">Ctrl K</Kbd>
          </Button>
        </div>

        <div className="flex min-h-10 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <ShieldAlertIcon className="size-4 shrink-0" aria-hidden="true" />
          <strong>Local single-user mode — no user identity or RBAC.</strong>
          <span className="hidden text-amber-800 sm:inline dark:text-amber-200">
            Não exponha este servidor na rede.
          </span>
        </div>

        {!session.canMutate && (
          <div className="border-b bg-muted/60 px-4 py-2 text-xs text-muted-foreground" role="status">
            A sessão perdeu a autoridade de escrita. Reinicie <code>luna studio</code> se a sessão local expirou.
          </div>
        )}

        <main
          id="studio-main"
          ref={mainRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <span className="sr-only" role="status" aria-live="polite">
            Página atual: {segmentLabels[location.pathname.split("/").filter(Boolean).at(-1) ?? ""] ?? "Início"}
          </span>
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}
