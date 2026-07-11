import type { KeyboardEvent } from "react"

export function focusWorkflowOutlineSibling(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
) {
  const buttons = event.currentTarget
    .closest("ol")
    ?.querySelectorAll<HTMLButtonElement>("button[data-outline-node]")
  if (buttons === undefined || buttons.length === 0) return

  let nextIndex: number | undefined
  if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, buttons.length - 1)
  if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0)
  if (event.key === "Home") nextIndex = 0
  if (event.key === "End") nextIndex = buttons.length - 1
  if (nextIndex === undefined) return

  event.preventDefault()
  buttons[nextIndex]?.focus()
}
