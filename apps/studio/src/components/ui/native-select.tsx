import * as React from "react"
import { Select } from "@base-ui/react/select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size" | "onChange"> & {
  size?: "sm" | "default"
  onChange?: React.ChangeEventHandler<HTMLSelectElement>
}

type SelectOption = {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

function optionText(value: React.ReactNode): string {
  return React.Children.toArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child)
    if (React.isValidElement(child)) {
      return optionText((child.props as { children?: React.ReactNode }).children)
    }
    return ""
  }).join("")
}

function optionItems(children: React.ReactNode): SelectOption[] {
  return React.Children.toArray(children).flatMap((child) => {
    if (!React.isValidElement(child)) return []
    if (child.type === NativeSelectOption) {
      const props = child.props as React.ComponentProps<"option">
      return [{
        value: String(props.value ?? ""),
        label: props.children,
        disabled: props.disabled,
      }]
    }
    if (child.type === NativeSelectOptGroup) {
      const props = child.props as React.ComponentProps<"optgroup">
      return optionItems(props.children)
    }
    return []
  })
}

function NativeSelect({
  className,
  size = "default",
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  id,
  name,
  required,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  ...props
}: NativeSelectProps) {
  const options = optionItems(children)
  const items = options.map(({ value: optionValue, label }) => ({ value: optionValue, label }))
  const selectedValue = value === undefined
    ? defaultValue === undefined
      ? null
      : String(defaultValue)
    : String(value)

  const emitChange = (nextValue: string | string[] | null) => {
    const next = typeof nextValue === "string" ? nextValue : ""
    onChange?.({
      target: { value: next },
      currentTarget: { value: next },
    } as unknown as React.ChangeEvent<HTMLSelectElement>)
  }

  return (
    <Select.Root
      items={items}
      value={selectedValue}
      onValueChange={emitChange}
      disabled={disabled}
      name={name}
      required={required}
      {...props}
    >
      <div
        className={cn("group/native-select relative w-fit", className)}
        data-slot="native-select-wrapper"
        data-size={size}
      >
        <select
          data-slot="native-select-compat"
          className="sr-only"
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          name={name}
          required={required}
          disabled={disabled}
          value={value === undefined ? undefined : String(value)}
          defaultValue={value === undefined ? defaultValue : undefined}
          onChange={onChange}
          {...props}
        >
          {children}
        </select>
        <Select.Trigger
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-hidden="true"
          tabIndex={-1}
          data-slot="native-select"
          data-size={size}
          className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-1.5 text-sm shadow-xs transition-colors outline-none hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[size=sm]:h-8 data-[size=sm]:rounded-md data-[size=sm]:px-2.5"
        >
          <Select.Value placeholder={options.find((option) => option.value === "")?.label ?? "Selecione"} />
          <Select.Icon>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" data-slot="native-select-icon" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={5} className="z-50 outline-none">
            <Select.Popup className="min-w-[var(--anchor-width)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/15 outline-none data-[side=bottom]:animate-in data-[side=top]:animate-in">
              <Select.List className="max-h-[min(22rem,var(--available-height),calc(100dvh-1rem))] overflow-y-auto overscroll-contain">
                {options.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="relative flex min-h-9 cursor-pointer select-none items-center rounded-md py-1.5 pr-8 pl-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45"
                  >
                    <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                      <CheckIcon className="size-4" aria-hidden="true" />
                    </Select.ItemIndicator>
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </div>
    </Select.Root>
  )
}

function NativeSelectOption({
  className,
  children,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn(className)}
      aria-label={optionText(children) || undefined}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-optgroup" className={cn(className)} {...props} />
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
