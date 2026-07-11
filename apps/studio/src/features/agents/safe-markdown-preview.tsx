import type { ReactNode } from "react"

import { safeMarkdownBlocks } from "@/features/agents/safe-markdown"

function Heading({ level, children }: { level: number; children: ReactNode }) {
  const className = level <= 2 ? "text-base font-semibold" : "text-sm font-semibold"
  if (level === 1) return <h1 className={className}>{children}</h1>
  if (level === 2) return <h2 className={className}>{children}</h2>
  if (level === 3) return <h3 className={className}>{children}</h3>
  return <h4 className={className}>{children}</h4>
}

export function SafeMarkdownPreview({ markdown }: { markdown: string }) {
  const blocks = safeMarkdownBlocks(markdown)
  if (blocks.length === 0) {
    return <p className="text-sm text-muted-foreground">As instruções estão vazias.</p>
  }
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return <Heading key={index} level={block.level}>{block.text}</Heading>
        }
        if (block.kind === "quote") {
          return <blockquote key={index} className="border-l-2 pl-3 text-muted-foreground whitespace-pre-wrap">{block.text}</blockquote>
        }
        if (block.kind === "code") {
          return <pre key={index} className="overflow-auto rounded-lg bg-muted p-3 font-mono text-xs"><code data-language={block.language}>{block.text}</code></pre>
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul"
          return <List key={index} className={block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</List>
        }
        return <p key={index} className="whitespace-pre-wrap">{block.text}</p>
      })}
    </div>
  )
}
