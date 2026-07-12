import type { DraftFile } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  draftFileIsDirty,
  draftFileKey,
  type DraftFileContents,
} from "@/features/drafts/draft-file-session"
import { Code2Icon } from "lucide-react"

import { pathLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

export function DraftFilesEditor({
  files,
  baseContents,
  contents,
  selectedFileKey,
  canMutate,
  onSelectFile,
  onContentChange,
}: {
  files: DraftFile[]
  baseContents: DraftFileContents
  contents: DraftFileContents
  selectedFileKey?: string
  canMutate: boolean
  onSelectFile: (key: string) => void
  onContentChange: (key: string, content: string) => void
}) {
  const selectedFile = files.find((file) => draftFileKey(file) === selectedFileKey)
  return (
    <div className="grid min-h-[calc(100vh-15rem)] grid-cols-1 md:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="border-b p-3 md:border-r md:border-b-0">
        <h2 className="mb-3 text-sm font-medium">Arquivos do change set</h2>
        <div className="space-y-1">
          {files.map((file) => {
            const key = draftFileKey(file)
            const dirty = draftFileIsDirty(
              { baseContents, workingContents: contents },
              key,
            )
            return (
              <button
                type="button"
                key={key}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", key === selectedFileKey && "bg-muted font-medium")}
                onClick={() => onSelectFile(key)}
                aria-pressed={key === selectedFileKey}
              >
                <Code2Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{file.file.path.split("/").at(-1)}</span>
                {dirty && <span className="size-2 rounded-full bg-amber-500" aria-label="Alterado localmente" />}
              </button>
            )
          })}
        </div>
      </aside>
      <section className="flex min-h-0 flex-col">
        {selectedFile === undefined ? (
          <p className="p-6 text-sm text-muted-foreground">Selecione um arquivo.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2"><code className="truncate text-xs">{pathLabel(selectedFile.file)}</code><Badge variant="outline">{selectedFile.media_type}</Badge></div>
            <Textarea
              value={contents[draftFileKey(selectedFile)] ?? ""}
              onChange={(event) => onContentChange(draftFileKey(selectedFile), event.target.value)}
              disabled={!canMutate}
              spellCheck={false}
              aria-label={`Conteúdo de ${selectedFile.file.path}`}
              className="min-h-[calc(100vh-18rem)] flex-1 resize-none rounded-none border-0 p-4 font-mono text-xs leading-relaxed focus-visible:ring-0"
            />
          </>
        )}
      </section>
    </div>
  )
}
