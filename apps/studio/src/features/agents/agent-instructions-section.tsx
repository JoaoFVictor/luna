import { useEffect } from "react"
import { EyeIcon, FileTextIcon, SaveIcon, ShieldCheckIcon } from "lucide-react"
import { STUDIO_DRAFT_AUTHORING_LIMITS } from "../../../../../src/studio/contracts/draft-authoring.js"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { SafeMarkdownPreview } from "@/features/agents/safe-markdown-preview"
import { useServerBackedForm } from "@/features/agents/use-server-backed-form"

export function AgentInstructionsSection({
  path,
  content,
  disabled,
  pending,
  onDirtyChange,
  onSave,
}: {
  path: string
  content: string
  disabled: boolean
  pending: boolean
  onDirtyChange: (dirty: boolean) => void
  onSave: (content: string) => void
}) {
  const editor = useServerBackedForm(content)
  const bytes = new TextEncoder().encode(editor.value).byteLength
  const tooLarge =
    editor.value.length > STUDIO_DRAFT_AUTHORING_LIMITS.maxContentCharacters ||
    bytes > STUDIO_DRAFT_AUTHORING_LIMITS.maxContentBytes

  useEffect(() => onDirtyChange(editor.dirty), [editor.dirty, onDirtyChange])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><FileTextIcon className="size-4" aria-hidden="true" /> Instruções</h2>
          <p className="text-xs text-muted-foreground">Diga como o agent deve raciocinar, agir e responder.</p>
        </div>
        <div className="flex gap-2">
          <Badge variant={tooLarge ? "destructive" : "outline"}>{editor.value.length.toLocaleString()} caracteres</Badge>
          <Badge variant={tooLarge ? "destructive" : "outline"}>{bytes.toLocaleString()} bytes UTF-8</Badge>
        </div>
      </div>
      <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer"><ShieldCheckIcon className="mr-2 inline size-4" aria-hidden="true" />Detalhes do arquivo e preview</summary><p className="mt-2"><code>{path}</code>. O preview não executa HTML nem abre links.</p></details>
      <Tabs defaultValue="edit">
        <TabsList>
          <TabsTrigger value="edit"><FileTextIcon aria-hidden="true" /> Editar</TabsTrigger>
          <TabsTrigger value="text"><EyeIcon aria-hidden="true" /> Texto</TabsTrigger>
          <TabsTrigger value="markdown"><EyeIcon aria-hidden="true" /> Markdown seguro</TabsTrigger>
        </TabsList>
        <TabsContent value="edit" className="pt-4">
          <Textarea
            value={editor.value}
            disabled={disabled}
            spellCheck
            aria-label="Instruções UTF-8 do agent"
            className="min-h-[24rem] font-mono text-xs leading-relaxed"
            onChange={(event) => editor.setValue(event.target.value)}
          />
        </TabsContent>
        <TabsContent value="text" className="pt-4">
          <pre className="min-h-48 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-4 text-sm">{editor.value}</pre>
        </TabsContent>
        <TabsContent value="markdown" className="pt-4">
          <div className="min-h-48 rounded-lg border bg-background p-4"><SafeMarkdownPreview markdown={editor.value} /></div>
        </TabsContent>
      </Tabs>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={disabled || pending || !editor.dirty || tooLarge} onClick={() => onSave(editor.value)}>
          <SaveIcon aria-hidden="true" />{pending ? "Salvando…" : "Salvar instruções"}
        </Button>
        {editor.dirty && <Button variant="ghost" onClick={editor.reset}>Descartar alterações</Button>}
        {!editor.dirty && <Badge variant="outline">sincronizado</Badge>}
      </div>
    </div>
  )
}
