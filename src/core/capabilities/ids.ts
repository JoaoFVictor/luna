export function isNamespacedCapabilityId(id: string): boolean {
  return /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(id);
}
