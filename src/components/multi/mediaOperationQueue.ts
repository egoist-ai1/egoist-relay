type Task = { id: string; kind: 'save' | 'send'; run: () => Promise<void> };

// Only captures wait here. Decoding starts when one task owns the worker.
export default class MediaOperationQueue {
  private waiting: Task[] = [];
  private running?: Task;
  private isLocked = true;
  private completion = new Map<string, { promise: Promise<void>; resolve: NoneToVoidFunction }>();

  get size() { return this.waiting.length + (this.running ? 1 : 0); }

  add(task: Task) {
    if (this.size >= 9) throw new Error('MEDIA_QUEUE_FULL');
    if (this.waiting.some(({ id }) => id === task.id) || this.running?.id === task.id) {
      throw new Error('MEDIA_OPERATION_BUSY');
    }
    let resolve!: NoneToVoidFunction;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });

    this.completion.set(task.id, { promise, resolve });
    this.waiting.push(task);
    this.drain();
  }

  cancel(id: string): boolean {
    const index = this.waiting.findIndex((task) => task.id === id);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    this.completion.get(id)?.resolve();
    this.completion.delete(id);
    return true;
  }

  whenIdle(id: string): Promise<void> {
    return this.completion.get(id)?.promise || Promise.resolve();
  }

  setLocked(isLocked: boolean) {
    this.isLocked = isLocked;
    this.drain();
  }

  private drain() {
    if (this.running) return;
    const index = this.waiting.findIndex((task) => !this.isLocked || task.kind === 'save');
    if (index < 0) return;
    const [task] = this.waiting.splice(index, 1);
    this.running = task;
    // Run on a separate turn so accepting a dialog does not synchronously decode media.
    void Promise.resolve().then(task.run).catch(() => undefined).finally(() => {
      this.running = undefined;
      this.completion.get(task.id)?.resolve();
      this.completion.delete(task.id);
      this.drain();
    });
  }
}
