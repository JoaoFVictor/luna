export type StudioProviderHealthObservation = {
  readonly adapterId: string;
  readonly checkedAt: string;
};

export class StudioProviderHealthTracker {
  readonly #observations = new Map<string, StudioProviderHealthObservation>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  markHealthy(providerId: string, adapterId: string): void {
    this.#observations.set(providerId, {
      adapterId,
      checkedAt: this.#now().toISOString()
    });
  }

  get(providerId: string): StudioProviderHealthObservation | undefined {
    return this.#observations.get(providerId);
  }
}
