const WORDS: Readonly<Record<string, string>> = {
  api: "API",
  id: "ID",
  json: "JSON",
  mcp: "MCP",
  url: "URL",
}

function humanizeWords(value: string): string {
  return value
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word) => WORDS[word.toLocaleLowerCase()] ?? word.toLocaleLowerCase())
    .join(" ")
}

export function humanizeTechnicalId(value: string, keepNamespace = false): string {
  const source = keepNamespace ? value : value.split(".").at(-1) ?? value
  const words = humanizeWords(source)
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

export function presentationTitle(id: string, title: string): string {
  return title === id ? humanizeTechnicalId(id) : title
}
