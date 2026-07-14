import { describe, expect, it, vi } from "vitest"

import {
  installBrowserErrorPolicy,
  isResizeObserverDeliveryNotice,
} from "./browser-error-policy"

const DELIVERY_NOTICE = "ResizeObserver loop completed with undelivered notifications."

function browserNotice(overrides: ErrorEventInit = {}): ErrorEvent {
  return new ErrorEvent("error", {
    cancelable: true,
    message: DELIVERY_NOTICE,
    filename: window.location.href,
    lineno: 0,
    colno: 0,
    ...overrides,
  })
}

describe("browser error policy", () => {
  it("recognizes only the document-owned, zero-coordinate ResizeObserver notice", () => {
    expect(isResizeObserverDeliveryNotice(browserNotice())).toBe(true)
    expect(isResizeObserverDeliveryNotice(browserNotice({
      error: new Error(DELIVERY_NOTICE),
    }))).toBe(false)
    expect(isResizeObserverDeliveryNotice(browserNotice({
      filename: "workflow-graph.js",
      lineno: 42,
    }))).toBe(false)
    expect(isResizeObserverDeliveryNotice(browserNotice({
      filename: "http://127.0.0.1:43110/runs/another-run",
    }))).toBe(false)
    expect(isResizeObserverDeliveryNotice(new ErrorEvent("error", {
      message: "ResizeObserver loop limit exceeded",
    }))).toBe(false)
  })

  it("consumes the browser notice without swallowing real window errors", () => {
    const target = new EventTarget()
    Object.defineProperty(target, "location", {
      value: { href: window.location.href },
    })
    const downstream = vi.fn()
    const uninstall = installBrowserErrorPolicy(target as unknown as Window)
    target.addEventListener("error", downstream)

    const notice = browserNotice()
    expect(target.dispatchEvent(notice)).toBe(false)
    expect(notice.defaultPrevented).toBe(true)
    expect(downstream).not.toHaveBeenCalled()

    const exception = browserNotice({ error: new Error(DELIVERY_NOTICE) })
    expect(target.dispatchEvent(exception)).toBe(true)
    expect(downstream).toHaveBeenCalledOnce()
    expect(downstream).toHaveBeenCalledWith(exception)

    uninstall()
  })
})
