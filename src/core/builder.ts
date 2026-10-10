/**
 * Builds things a little at a time, so nothing big is ever made in one frame.
 * A job is a generator: it does a piece of work and yields. Yielding a promise
 * (a shader compile running in the background, say) parks the job until the
 * promise settles; the rest of the game goes on meanwhile.
 */
export class Builder {
  private readonly jobs: { gen: Generator<unknown, void, unknown>; wait: boolean }[] = [];

  add(gen: Generator<unknown, void, unknown>) {
    this.jobs.push({ gen, wait: false });
  }

  get busy() {
    return this.jobs.length > 0;
  }

  /** Work for up to `ms` milliseconds. */
  run(ms: number) {
    const end = performance.now() + ms;
    for (let i = 0; i < this.jobs.length && performance.now() < end; ) {
      const job = this.jobs[i];
      if (job.wait) {
        i++;
        continue;
      }
      const r = job.gen.next();
      if (r.done) {
        this.jobs.splice(i, 1);
        continue;
      }
      if (r.value instanceof Promise) {
        job.wait = true;
        r.value.then(
          () => (job.wait = false),
          () => (job.wait = false),
        );
        i++;
      }
    }
  }
}
