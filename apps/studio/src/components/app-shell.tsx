import { useQuery } from "@tanstack/react-query"
import { Fragment, useEffect, useRef, useState } from "react"
import {
  BotIcon,
  BoxesIcon,
  CircleIcon,
  HouseIcon,
  MoonIcon,
  NetworkIcon,
  RocketIcon,
  PlayIcon,
  SearchIcon,
  Settings2Icon,
  ShieldAlertIcon,
  SunIcon,
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
  { label: "Executar", to: "/launch", icon: RocketIcon },
  { label: "Agents", to: "/agents", icon: BotIcon },
  { label: "Blocos", to: "/library", icon: BoxesIcon },
  { label: "Conexões", to: "/configuration", icon: Settings2Icon },
  { label: "Execuções", to: "/runs", icon: PlayIcon },
] as const

const segmentLabels: Record<string, string> = {
  workflows: "Workflows",
  launch: "Executar",
  drafts: "Draft",
  "agent-drafts": "Agents",
  agents: "Agents",
  library: "Blocos",
  configuration: "Conexões",
  runs: "Execuções",
}

function currentSection(pathname: string): string {
  const root = pathname.split("/").filter(Boolean)[0] ?? ""
  if (root === "drafts") return "Workflows"
  if (root === "agent-drafts") return "Agents"
  return segmentLabels[root] ?? "Início"
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
          const linkPath = segment === "drafts"
            ? "/workflows"
            : segment === "agent-drafts"
              ? "/agents"
              : path
          const isLast = index === segments.length - 1
          const label = segmentLabels[segment] ?? (segment.length > 24 ? `${segment.slice(0, 8)}…` : segment)
          return (
            <Fragment key={path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link to={linkPath} />}>{label}</BreadcrumbLink>
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
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  )

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark"
    document.documentElement.classList.toggle("dark", next === "dark")
    window.localStorage.setItem("luna-theme", next)
    setTheme(next)
  }

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true })
  }, [location.pathname])

  return (
    <SidebarProvider className="h-dvh min-h-0">
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
                <img
                  src="/favicon.svg"
                  alt=""
                  aria-hidden="true"
                  className="size-8 rounded-lg"
                />
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
                      : location.pathname.startsWith(item.to) ||
                        (item.to === "/workflows" && location.pathname.startsWith("/drafts/")) ||
                        (item.to === "/agents" && location.pathname.startsWith("/agent-drafts/"))
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

      <SidebarInset className="h-dvh min-h-0 overflow-hidden">
        <div className="sticky top-0 z-40 flex min-h-12 shrink-0 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur sm:px-4">
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
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
            title={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
          >
            {theme === "dark" ? <SunIcon aria-hidden="true" /> : <MoonIcon aria-hidden="true" />}
          </Button>
        </div>

        <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <ShieldAlertIcon className="size-4 shrink-0" aria-hidden="true" />
          <strong>Modo local para um usuário — sem login ou RBAC.</strong>
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
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
        >
          <span className="sr-only" role="status" aria-live="polite">
            Página atual: {currentSection(location.pathname)}
          </span>
          <Outlet />
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}
