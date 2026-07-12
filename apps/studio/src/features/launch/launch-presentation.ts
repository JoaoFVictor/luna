import { humanizeTechnicalId } from "@/lib/presentation"

const effectLabels: Readonly<Record<string, string>> = {
  credential_read: "Usará a conexão configurada",
  network_read: "Consultará dados externos",
  process_execution: "Poderá executar um processo local",
  repository_read: "Lerá o repositório selecionado",
  repository_write: "Poderá alterar arquivos do repositório",
}

export function launchEffectLabel(effect: string): string {
  return effectLabels[effect] ?? effect
    .replace(/[-_]+/gu, " ")
    .replace(/^./u, (letter) => letter.toLocaleUpperCase())
}

export function launchAdapterLabel(id: string, source: string): string {
  const name = humanizeTechnicalId(id)
  return source.trim().length === 0
    ? name
    : `${name} · ${humanizeTechnicalId(source, true)}`
}

export function launchAdapterDescription(id: string, fallback: string): string {
  return fallback || `Prepara uma entrada usando ${id}.`
}

export function launchAdapterPlaceholder(): string {
  return "Informe o valor esperado por este adapter"
}
