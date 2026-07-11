export type MarkdownBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "code"; readonly language: string; readonly text: string }

function listLine(line: string): { ordered: boolean; text: string } | undefined {
  const unordered = /^\s*[-*+]\s+(.+)$/u.exec(line)
  if (unordered !== null) return { ordered: false, text: unordered[1] ?? "" }
  const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line)
  return ordered === null ? undefined : { ordered: true, text: ordered[1] ?? "" }
}

export function safeMarkdownBlocks(markdown: string): readonly MarkdownBlock[] {
  const lines = markdown.split(/\r?\n/u)
  const blocks: MarkdownBlock[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ""
    const fence = /^\s*```([^`]*)$/u.exec(line)
    if (fence !== null) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "")
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ kind: "code", language: (fence[1] ?? "").trim(), text: code.join("\n") })
      continue
    }
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line)
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" })
      index += 1
      continue
    }
    const quote = /^\s*>\s?(.*)$/u.exec(line)
    if (quote !== null) {
      blocks.push({ kind: "quote", text: quote[1] ?? "" })
      index += 1
      continue
    }
    const firstListItem = listLine(line)
    if (firstListItem !== undefined) {
      const items = [firstListItem.text]
      index += 1
      while (index < lines.length) {
        const item = listLine(lines[index] ?? "")
        if (item === undefined || item.ordered !== firstListItem.ordered) break
        items.push(item.text)
        index += 1
      }
      blocks.push({ kind: "list", ordered: firstListItem.ordered, items })
      continue
    }
    const paragraph = [line]
    index += 1
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^\s*```/u.test(lines[index] ?? "") &&
      !/^(#{1,6})\s+/u.test(lines[index] ?? "") &&
      !/^\s*>/u.test(lines[index] ?? "") &&
      listLine(lines[index] ?? "") === undefined
    ) {
      paragraph.push(lines[index] ?? "")
      index += 1
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") })
  }
  return blocks
}
