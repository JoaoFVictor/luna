import { useCallback, useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { BotIcon, BoxesIcon, HouseIcon, NetworkIcon, PlayIcon, RocketIcon, Settings2Icon } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { agentsQuery, workflowsQuery } from "@/api/queries"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"

const destinations = [
  { label: "Início", to: "/", icon: HouseIcon, shortcut: "G H" },
  { label: "Workflows", to: "/workflows", icon: NetworkIcon, shortcut: "G W" },
  { label: "Launch", to: "/launch", icon: RocketIcon, shortcut: "G X" },
  { label: "Agents", to: "/agents", icon: BotIcon, shortcut: "G A" },
  { label: "Library", to: "/library", icon: BoxesIcon, shortcut: "G L" },
  { label: "Configuration", to: "/configuration", icon: Settings2Icon, shortcut: "G C" },
  { label: "Runs", to: "/runs", icon: PlayIcon, shortcut: "G R" },
] as const

const shortcutDestinations = new Map(
  destinations.map((item) => [item.shortcut.at(-1)?.toLowerCase(), item.to]),
)

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const workflows = useQuery(workflowsQuery)
  const agents = useQuery(agentsQuery)
  const chordStartedAt = useRef<number | undefined>(undefined)

  const go = useCallback(
    (path: string) => {
      onOpenChange(false)
      void navigate(path)
    },
    [navigate, onOpenChange],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        chordStartedAt.current = undefined
        return
      }
      const now = performance.now()
      if (event.key.toLowerCase() === "g") {
        chordStartedAt.current = now
        return
      }
      if (chordStartedAt.current === undefined || now - chordStartedAt.current > 1200) {
        chordStartedAt.current = undefined
        return
      }
      const destination = shortcutDestinations.get(event.key.toLowerCase())
      chordStartedAt.current = undefined
      if (destination !== undefined) {
        event.preventDefault()
        go(destination)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [go])

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Paleta de comandos"
      description="Abra áreas e recursos do Luna Studio"
    >
      <Command>
        <CommandInput placeholder="Buscar comando, workflow ou agent…" autoFocus />
        <CommandList>
          <CommandEmpty>Nenhum item encontrado.</CommandEmpty>
          <CommandGroup heading="Navegação">
            {destinations.map((item) => (
              <CommandItem key={item.to} value={item.label} onSelect={() => go(item.to)}>
                <item.icon aria-hidden="true" />
                {item.label}
                <CommandShortcut>{item.shortcut}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          {(workflows.data?.workflows.length ?? 0) > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Workflows">
                {workflows.data?.workflows.map((workflow) => (
                  <CommandItem
                    key={workflow.id}
                    value={`workflow ${workflow.id}`}
                    onSelect={() => go(`/workflows/${encodeURIComponent(workflow.id)}`)}
                  >
                    <NetworkIcon aria-hidden="true" />
                    {workflow.id}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {(agents.data?.agents.length ?? 0) > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Agents">
                {agents.data?.agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={`agent ${agent.id}`}
                    onSelect={() => go(`/agents?selected=${encodeURIComponent(agent.id)}`)}
                  >
                    <BotIcon aria-hidden="true" />
                    {agent.id}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
