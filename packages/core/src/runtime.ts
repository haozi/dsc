export type Dispose = () => void | Promise<void>

export interface Plugin {
  name: string
  apply(context: Runtime): void | Dispose | Promise<void | Dispose>
}

export interface ServiceMap {}

type ServiceName = keyof ServiceMap

export class Runtime {
  readonly #services = new Map<ServiceName, ServiceMap[ServiceName]>()
  readonly #effects: Dispose[] = []
  #disposed = false

  provide<Name extends ServiceName>(
    name: Name,
    value: ServiceMap[Name],
  ): Dispose {
    this.assertActive()
    if (this.#services.has(name)) {
      throw new Error(`Service ${String(name)} is already provided`)
    }
    this.#services.set(name, value)
    return () => {
      if (this.#services.get(name) === value) this.#services.delete(name)
    }
  }

  require<Name extends ServiceName>(name: Name): ServiceMap[Name] {
    const service = this.#services.get(name)
    if (service === undefined)
      throw new Error(`Required service ${String(name)} is unavailable`)
    return service as ServiceMap[Name]
  }

  effect(setup: () => Dispose): void {
    this.assertActive()
    this.#effects.push(setup())
  }

  async mount(plugins: readonly Plugin[]): Promise<void> {
    for (const plugin of plugins) {
      try {
        const dispose = await plugin.apply(this)
        if (dispose !== undefined) this.#effects.push(dispose)
      } catch (error) {
        await this.dispose()
        throw new Error(`Plugin ${plugin.name} failed to mount`, {
          cause: error,
        })
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true

    const errors: unknown[] = []
    for (const dispose of this.#effects.reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    this.#effects.length = 0
    this.#services.clear()
    if (errors.length > 0)
      throw new AggregateError(errors, 'Runtime disposal failed')
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error('Runtime is already disposed')
  }
}
