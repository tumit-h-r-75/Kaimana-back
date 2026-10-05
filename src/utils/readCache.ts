/** Per-instance TTL cache for public reads, including in-flight query coalescing. */
export class ReadCache {
  private entries = new Map<string, { expiresAt: number; value?: unknown; pending?: Promise<unknown> }>();

  constructor(private readonly capacity = 100, private readonly now = () => Date.now()) {}

  clear() { this.entries.clear(); }

  read<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing?.pending) return existing.pending as Promise<T>;
    if (existing && existing.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return Promise.resolve(existing.value as T);
    }
    const entry: { expiresAt: number; value?: unknown; pending?: Promise<unknown> } = { expiresAt: 0 };
    const pending = Promise.resolve().then(load).then(
      (value) => {
        if (this.entries.get(key) === entry) {
          entry.value = value;
          entry.expiresAt = this.now() + ttl;
          delete entry.pending;
        }
        return value;
      },
      (error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    entry.pending = pending;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return pending;
  }
}

export const catalogueCache = new ReadCache();
export const problemTopicsCache = new ReadCache(1);
