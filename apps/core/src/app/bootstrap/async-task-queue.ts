export class AsyncTaskQueue {
  private activeCount = 0;
  private readonly pending: Array<() => Promise<void>> = [];
  private pendingHead = 0;
  private drainResolvers: Array<() => void> = [];
  private slotResolvers: Array<() => void> = [];
  private slotResolverHead = 0;

  constructor(
    private readonly maxActive: number,
    private readonly maxPending: number,
    _maxWaiting = maxPending,
  ) {
    void _maxWaiting;
  }

  enqueue(task: () => Promise<void>): boolean {
    if (this.size() >= this.maxPending) return false;
    this.pending.push(task);
    this.drain();
    return true;
  }

  async enqueueWhenAvailable(task: () => Promise<void>): Promise<boolean> {
    while (!this.enqueue(task)) {
      await this.waitForSlot();
    }
    return true;
  }

  async waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (this.isIdle()) {
      return true;
    }
    const idle = new Promise<boolean>((resolve) =>
      this.drainResolvers.push(() => resolve(true)),
    );
    if (typeof timeoutMs !== 'number') return idle;
    return Promise.race([
      idle,
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), timeoutMs),
      ),
    ]);
  }

  size(): number {
    return this.activeCount + this.pending.length - this.pendingHead;
  }

  private isIdle(): boolean {
    return this.activeCount === 0 && this.pendingHead >= this.pending.length;
  }

  private drain(): void {
    while (
      this.activeCount < this.maxActive &&
      this.pendingHead < this.pending.length
    ) {
      const task = this.pending[this.pendingHead]!;
      this.pendingHead += 1;
      if (
        this.pendingHead > 1024 &&
        this.pendingHead * 2 > this.pending.length
      ) {
        this.pending.splice(0, this.pendingHead);
        this.pendingHead = 0;
      }
      this.activeCount += 1;
      task()
        .catch(() => {
          // Callers own task-level error reporting.
        })
        .finally(() => {
          this.activeCount -= 1;
          this.resolveNextSlotWaiterIfAvailable();
          this.resolveDrainIfIdle();
          this.drain();
        });
    }
  }

  private resolveNextSlotWaiterIfAvailable(): void {
    if (this.size() >= this.maxPending) return;
    if (this.slotResolverHead >= this.slotResolvers.length) return;

    const resolve = this.slotResolvers[this.slotResolverHead]!;
    this.slotResolverHead += 1;
    if (
      this.slotResolverHead > 1024 &&
      this.slotResolverHead * 2 > this.slotResolvers.length
    ) {
      this.slotResolvers.splice(0, this.slotResolverHead);
      this.slotResolverHead = 0;
    }
    resolve();
  }

  private resolveDrainIfIdle(): void {
    if (!this.isIdle()) return;
    this.pending.length = 0;
    this.pendingHead = 0;
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private waitForSlot(): Promise<void> {
    if (this.size() < this.maxPending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.slotResolvers.push(resolve);
    });
  }
}
