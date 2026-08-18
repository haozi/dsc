import type { Command, Plugin } from '@tiny-harness/core'

const helpCommand: Command = {
  name: 'help',
  description: 'List available commands',
  run(_args, context) {
    const commands = context.require('commands').list()
    const width = Math.max(
      ...commands.map((command) => (command.usage ?? command.name).length),
    )
    return {
      output: commands
        .map(
          (command) =>
            `  ${(command.usage ?? command.name).padEnd(width)}  ${command.description}`,
        )
        .join('\n'),
    }
  },
}

const commands: readonly Command[] = [
  {
    name: 'about',
    description: 'Show framework information',
    run: () => ({
      output: 'tiny-harness-cli · Bun + React + Ink · plugin-driven',
    }),
  },
  {
    name: 'clear',
    description: 'Clear the transcript',
    run: () => ({ action: 'clear' }),
  },
  {
    name: 'echo',
    usage: 'echo <text>',
    description: 'Print text',
    run: (args) => ({ output: args.join(' ') }),
  },
  {
    name: 'exit',
    description: 'Exit the interactive CLI',
    run: () => ({ action: 'exit' }),
  },
  helpCommand,
]

export const builtinsPlugin: Plugin = {
  name: 'builtins',
  apply(context) {
    const registry = context.require('commands')
    for (const command of commands) {
      context.effect(() => registry.register(command))
    }
  },
}
