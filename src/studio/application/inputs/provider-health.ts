export type StudioProviderHealthObservation = {
  readonly probeId: string;
  readonly checkedAt: string;
};

export class StudioProviderHealthTracker {
  readonly #observations = new Map<string, StudioProviderHealthObservation>();

  markHealthy(providerId: string, probeId: string, checkedAt: string): void {
    this.#observations.set(providerId, {
      probeId,
      checkedAt
    });
  }

  clear(providerId: string): void {
    this.#observations.delete(providerId);
  }

  get(providerId: string): StudioProviderHealthObservation | undefined {
    return this.#observations.get(providerId);
  }
}
