export type Invocation =
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'tui' }
  | { mode: 'run'; tokens: readonly string[] }

export function parseArgs(argv: readonly string[]): Invocation {
  const [mode, ...rest] = argv
  if (mode === undefined || mode === 'tui') return { mode: 'tui' }
  if (mode === '-h' || mode === '--help' || mode === 'help')
    return { mode: 'help' }
  if (mode === '-v' || mode === '--version') return { mode: 'version' }
  if (mode === 'run') {
    if (rest.length === 0)
      throw new Error(
        'The run mode needs a command, for example: tiny run echo "hello"',
      )
    return { mode: 'run', tokens: rest }
  }
  throw new Error(`Unknown mode: ${mode}`)
}

export const help = `tiny - a minimal plugin-driven React CLI

Usage:
  tiny                         start the interactive TUI
  tiny run <command> [args]    run one command and exit
  tiny --help                  show this help
  tiny --version               show the version

Examples:
  tiny
  tiny run help
  tiny run echo "hello world"
`
