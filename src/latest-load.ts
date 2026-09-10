/** One running load and one replaceable request. A superseded request cannot commit. */
export class LatestLoad {
  private tail: Promise<unknown> = Promise.resolve()
  private generation = 0
  private controller?: AbortController
  private pending = 0
  get busy(): boolean { return this.pending > 0 }
  cancel(): void { this.generation++; this.controller?.abort() }
  async run<T>(load: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const generation = ++this.generation
    this.controller?.abort()
    const previous = this.tail
    this.pending++
    const next = (async () => {
      await previous.catch(() => {})
      if (generation !== this.generation) return undefined
      const controller = new AbortController()
      this.controller = controller
      try {
        const result = await load(controller.signal)
        return generation === this.generation ? result : undefined
      } catch (error) {
        if (generation !== this.generation) return undefined
        throw error
      } finally { if (this.controller === controller) this.controller = undefined }
    })()
    this.tail = next
    try { return await next } finally { this.pending-- }
  }
}
