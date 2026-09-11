export interface MemoryCacheSnapshot<Value> {
  readonly value: Value;
  readonly isFresh: boolean;
}

interface MemoryCacheEntry<Value> {
  readonly value: Value;
  readonly expiresAt: number;
}

export class MemoryResourceCache<Value> {
  readonly #ttlMs: number;
  readonly #now: () => number;
  #entry: MemoryCacheEntry<Value> | undefined;
  #pending: Promise<Value | undefined> | undefined;
  #generation = 0;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  read(): MemoryCacheSnapshot<Value> | null {
    if (this.#entry === undefined) {
      return null;
    }
    return {
      value: this.#entry.value,
      isFresh: this.#now() < this.#entry.expiresAt,
    };
  }

  load(loader: () => Promise<Value>): Promise<Value | undefined> {
    if (this.#pending !== undefined) {
      return this.#pending;
    }

    const generation = this.#generation;
    const pending = loader()
      .then((value) => {
        if (generation !== this.#generation) {
          return undefined;
        }
        this.#entry = {
          value,
          expiresAt: this.#now() + this.#ttlMs,
        };
        return value;
      })
      .finally(() => {
        if (this.#pending === pending) {
          this.#pending = undefined;
        }
      });
    this.#pending = pending;
    return pending;
  }

  clear() {
    this.#generation += 1;
    this.#entry = undefined;
    this.#pending = undefined;
  }
}
