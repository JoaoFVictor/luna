import { redactValue } from "./redactor.js";

export type RunLogAttributes = Record<string, unknown>;

export type RunLogger = {
  info(event: string, attributes?: RunLogAttributes): void;
  warn(event: string, attributes?: RunLogAttributes): void;
  error(event: string, attributes?: RunLogAttributes): void;
};

type FlueLog = {
  info(message: string, attributes?: RunLogAttributes): void;
  warn(message: string, attributes?: RunLogAttributes): void;
  error(message: string, attributes?: RunLogAttributes): void;
};

export const noopRunLogger: RunLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function clean(attributes: RunLogAttributes | undefined): RunLogAttributes {
  return redactValue(attributes ?? {}) as RunLogAttributes;
}

export function createFlueRunLogger(ctx: { log: FlueLog }): RunLogger {
  return {
    info: (event, attributes) => ctx.log.info(event, clean(attributes)),
    warn: (event, attributes) => ctx.log.warn(event, clean(attributes)),
    error: (event, attributes) => ctx.log.error(event, clean(attributes))
  };
}
