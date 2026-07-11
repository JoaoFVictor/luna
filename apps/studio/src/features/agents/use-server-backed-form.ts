import { useEffect, useRef, useState } from "react"

function equal<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function useServerBackedForm<T>(serverValue: T) {
  const [value, setValue] = useState(serverValue)
  const previousServerValue = useRef(serverValue)
  const serverValueRef = useRef(serverValue)
  const serverKey = JSON.stringify(serverValue)
  serverValueRef.current = serverValue

  useEffect(() => {
    const next = serverValueRef.current
    setValue((current) => equal(current, previousServerValue.current) ? next : current)
    previousServerValue.current = next
  }, [serverKey])

  return {
    value,
    setValue,
    dirty: !equal(value, serverValue),
    reset: () => setValue(serverValue),
  }
}
