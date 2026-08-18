import type { Runtime } from './runtime.ts'

export type CommandAction = 'clear' | 'exit'

export interface CommandResult {
  output?: string
  action?: CommandAction
}

export interface Command {
  name: string
  description: string
  usage?: string
  run(
    args: readonly string[],
    context: Runtime,
  ): CommandResult | Promise<CommandResult>
}

export class CommandRegistry {
  readonly #commands = new Map<string, Command>()

  register(command: Command): () => void {
    if (this.#commands.has(command.name)) {
      throw new Error(`Command ${command.name} is already registered`)
    }
    this.#commands.set(command.name, command)
    return () => {
      if (this.#commands.get(command.name) === command)
        this.#commands.delete(command.name)
    }
  }

  list(): readonly Command[] {
    return [...this.#commands.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
  }

  async execute(
    tokens: readonly string[],
    context: Runtime,
  ): Promise<CommandResult> {
    const [name, ...args] = tokens
    if (name === undefined) return {}
    const command = this.#commands.get(name)
    if (command === undefined)
      throw new Error(`Unknown command: ${name}. Run "help" to list commands.`)
    return command.run(args, context)
  }
}
