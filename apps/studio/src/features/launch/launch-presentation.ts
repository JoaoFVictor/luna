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
  const known = source === "github"
    ? "Pull request do GitHub"
    : source === "jira"
      ? "Tarefa do Jira"
      : source === "plane"
        ? "Tarefa do Plane"
        : undefined
  if (known !== undefined) return known
  const leaf = id.split(".").at(-1) ?? id
  const name = leaf.replace(/[-_]+/gu, " ").replace(/^./u, (letter) => letter.toLocaleUpperCase())
  return source.trim().length === 0 ? name : `${name} · ${source}`
}

export function launchAdapterDescription(id: string, source: string, fallback: string): string {
  if (source === "github") return "Carrega um pull request do GitHub a partir da URL."
  if (source === "jira") return "Carrega uma tarefa do Jira a partir da URL."
  if (source === "plane") return "Carrega uma tarefa do Plane a partir da URL."
  return fallback || `Prepara uma entrada usando ${id}.`
}
