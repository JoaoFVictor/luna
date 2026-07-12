import { buttonVariants } from "@/components/ui/button"
import { PageEmpty } from "@/components/page-state"
import { Link } from "react-router-dom"

export function NotFoundPage() {
  return (
    <div className="p-6">
      <PageEmpty
        title="Página não encontrada"
        description="A rota solicitada não faz parte deste Studio."
        action={<Link className={buttonVariants()} to="/">Voltar ao início</Link>}
      />
    </div>
  )
}
