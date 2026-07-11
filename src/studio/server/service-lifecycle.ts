export type StudioServiceDisposer = () => Promise<void> | void;

/**
 * Wraps a composed service disposer so every owner in the startup chain can
 * safely release it without invoking the underlying cleanup more than once.
 */
export function onceStudioServiceDisposer(
  dispose: StudioServiceDisposer | undefined
): () => Promise<void> {
  let operation: Promise<void> | undefined;

  return () => {
    operation ??= Promise.resolve().then(async () => {
      await dispose?.();
    });
    return operation;
  };
}
