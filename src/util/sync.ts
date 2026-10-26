// Ограничение параллельности: сессии стенда и один диалог на тестового оператора.

export class Semaphore {
  private waiters: { resolve: () => void; owner: string }[] = [];
  private holders = new Map<string, number>();
  constructor(public capacity: number) {}

  get used(): number {
    let n = 0;
    for (const v of this.holders.values()) n += v;
    return n;
  }

  get queued(): number {
    return this.waiters.length;
  }

  owners(): string[] {
    return [...this.holders.keys()];
  }

  tryAcquire(owner: string): boolean {
    if (this.used >= this.capacity) return false;
    this.holders.set(owner, (this.holders.get(owner) ?? 0) + 1);
    return true;
  }

  acquire(owner: string, signal?: AbortSignal): Promise<void> {
    if (this.tryAcquire(owner)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = {
        owner,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('Ожидание сессии прервано'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  release(owner: string): void {
    const n = this.holders.get(owner) ?? 0;
    if (n <= 1) this.holders.delete(owner);
    else this.holders.set(owner, n - 1);
    while (this.waiters.length && this.used < this.capacity) {
      const w = this.waiters.shift()!;
      this.holders.set(w.owner, (this.holders.get(w.owner) ?? 0) + 1);
      w.resolve();
    }
  }
}

/** Последовательное выполнение по ключу: в один диалог — по одному запросу. */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  private busy = new Set<string>();

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    this.busy.add(key);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
