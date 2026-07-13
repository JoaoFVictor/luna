const RESIZE_OBSERVER_DELIVERY_NOTICE =
  "ResizeObserver loop completed with undelivered notifications."

/**
 * Chromium reports the ResizeObserver delivery guard through `window.error`,
 * even though it is not a thrown JavaScript exception: remaining resize
 * notifications are deferred to the next paint. XYFlow synchronously updates
 * its measured-node store from a ResizeObserver callback, which can trigger
 * this browser-generated notice while the graph settles after SPA navigation.
 *
 * Keep this predicate deliberately narrower than a message-only filter. The
 * browser attributes this notice to the current document with zero source
 * coordinates. A real exception carrying the same text still has an `error`,
 * executable source coordinates, or another source URL and must continue
 * through the application's normal error reporting path.
 */
export function isResizeObserverDeliveryNotice(
  event: ErrorEvent,
  documentUrl: string = window.location.href,
): boolean {
  return event.message === RESIZE_OBSERVER_DELIVERY_NOTICE &&
    event.error == null &&
    event.filename === documentUrl &&
    event.lineno === 0 &&
    event.colno === 0
}

/**
 * Normalizes a browser-generated delivery notice before diagnostics listeners
 * mistake it for an application failure. No thrown exception, resource error,
 * promise rejection, or differently-shaped ErrorEvent is suppressed.
 */
export function installBrowserErrorPolicy(target: Window = window): () => void {
  const handleError = (event: ErrorEvent) => {
    if (!isResizeObserverDeliveryNotice(event, target.location.href)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  target.addEventListener("error", handleError)
  return () => target.removeEventListener("error", handleError)
}
