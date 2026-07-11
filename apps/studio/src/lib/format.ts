export function formatDateTime(value: string | undefined): string {
  if (value === undefined) return "—"
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.valueOf())) return value
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(timestamp)
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "Indisponível"
  if (milliseconds < 1000) return `${milliseconds} ms`
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes} min ${remainingSeconds} s`
}

export function shortDigest(value: string | undefined, length = 10): string {
  if (value === undefined) return "—"
  return value.startsWith("sha256:")
    ? value.slice("sha256:".length, "sha256:".length + length)
    : value.slice(0, length)
}

export function pathLabel(file: { root: string; path: string }): string {
  return `${file.root}:${file.path}`
}
