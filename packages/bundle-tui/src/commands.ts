/**
 * The terminal's input pipeline: `!cmd` is the local shell lane, `/verb …`
 * resolves against the built-in verb table (built-ins win over same-named
 * harness commands), an unknown `/verb` is tried against the harness command
 * registry (`/compact`, `/goal`, `/feedback`, …), and anything else is a
 * prompt for the model. The verb table is the single registry — the UI does
 * not parse slash commands itself.
 * @module @dsc/bundle-tui/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  isPermissionMode,
  PERMISSION_MODES,
  resolvePermission,
  type PermissionMode,
} from '@dsc/core'
import { spawn } from 'node:child_process'
import type { TranscriptStore } from './store.ts'

/** What the UI does after a line was handled. */
export type Outcome = 'handled' | 'prompt' | 'exit'

/** The mutable model selection the agent reads at each step. */
export interface ModelSelectionRef {
  current:
    { provider: string; model: string; reasoningEffort?: string } | undefined
  assembled: unknown
}

/** Everything a verb may touch. */
export interface CommandContext {
  readonly ctx: Context
  readonly agent: {
    readonly session: { readonly id: string }
    cancel(cause: { kind: 'user' }): void
  }
  readonly store: TranscriptStore
  readonly selection: ModelSelectionRef
  readonly cwd: string
  setPermission(mode: PermissionMode): void
  /** Request the surface to exit. */
  exit(): void
}

/** One built-in verb. */
export interface Verb {
  name: string
  usage: string
  description: string
  run(args: string, command: CommandContext): void | Promise<void>
}

/** Harness command registry slice the dispatcher uses. */
interface HarnessCommands {
  list(agent: unknown): readonly { name: string; description: string }[]
  execute(
    agent: unknown,
    line: string,
    attachments: readonly never[],
    signal: AbortSignal,
  ): Promise<
    { result: { kind: 'success' | 'error'; text?: string } } | undefined
  >
}

const helpVerb: Verb = {
  name: 'help',
  usage: '/help',
  description: 'List commands',
  run(_args, command) {
    const commands = command.ctx.get('commands') as HarnessCommands | undefined
    const harness = commands?.list(command.agent) ?? []
    const rows: [string, string][] = BUILTIN_VERBS.map((verb) => [
      verb.usage,
      verb.description,
    ])
    for (const entry of harness) {
      if (BUILTIN_VERBS.some((verb) => verb.name === entry.name)) continue
      rows.push([`/${entry.name}`, entry.description])
    }
    rows.push(['!<cmd>', 'Run a shell command locally'])
    const width = Math.max(...rows.map(([usage]) => usage.length))
    command.store.command(
      rows
        .map(
          ([usage, description]) => `  ${usage.padEnd(width)}  ${description}`,
        )
        .join('\n'),
    )
  },
}

const clearVerb: Verb = {
  name: 'clear',
  usage: '/clear',
  description: 'Clear the transcript',
  run(_args, command) {
    command.store.clear()
  },
}

const exitVerb: Verb = {
  name: 'exit',
  usage: '/exit',
  description: 'Exit the terminal',
  run(_args, command) {
    command.exit()
  },
}

const modelVerb: Verb = {
  name: 'model',
  usage: '/model [use <id>]',
  description: 'Show or switch the model for the next request',
  run(args, command) {
    const tokens = args
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '')
    const current = command.selection.current
    if (tokens.length === 0) {
      command.store.command(
        current === undefined
          ? 'no model selected'
          : `${current.provider} / ${current.model}`,
      )
      return
    }
    const id = tokens[0] === 'use' ? tokens[1] : tokens[0]
    if (id === undefined) throw new Error('usage: /model use <id>')
    const [provider, model] = id.includes('/')
      ? id.split('/', 2)
      : [current?.provider, id]
    if (provider === undefined || model === undefined || model === '')
      throw new Error('usage: /model use [<provider>/]<model>')
    command.selection.current = { provider, model }
    command.store.setModel(provider, model)
    command.store.command(
      `model → ${provider} / ${model} (takes effect on the next request)`,
    )
  },
}

const permissionsVerb: Verb = {
  name: 'permissions',
  usage: '/permissions [mode]',
  description: `Show or switch the permission mode (${PERMISSION_MODES.join(' | ')})`,
  run(args, command) {
    const mode = args.trim()
    if (mode === '') {
      command.store.command(
        `${command.store.getSnapshot().permission}  (${PERMISSION_MODES.join(' | ')})`,
      )
      return
    }
    if (!isPermissionMode(mode))
      throw new Error(`unknown permission mode: ${mode}`)
    command.setPermission(mode)
    const stance = resolvePermission(mode)
    command.store.setPermission(mode)
    command.store.command(
      `permission → ${mode} (sandbox ${stance.sandboxMode}, approval ${stance.approvalPolicy})`,
    )
  },
}

const costVerb: Verb = {
  name: 'cost',
  usage: '/cost',
  description: 'Show token usage for this session',
  run(_args, command) {
    const { usage, turns, toolCalls } = command.store.getSnapshot()
    command.store.command(
      [
        `requests: ${turns}  tool calls: ${toolCalls}`,
        `input: ${usage.input_tokens}  output: ${usage.output_tokens}`,
        `cache read: ${usage.cache_read_input_tokens}  cache write: ${usage.cache_creation_input_tokens}`,
      ].join('\n'),
    )
  },
}

const sessionVerb: Verb = {
  name: 'session',
  usage: '/session',
  description: 'Show the session id and working directory',
  run(_args, command) {
    command.store.command(
      `session: ${command.agent.session.id}\ncwd: ${command.cwd}`,
    )
  },
}

const toolsVerb: Verb = {
  name: 'tools',
  usage: '/tools',
  description: 'List the tools the model can call',
  run(_args, command) {
    const tools = command.ctx.get('tools') as
      | { schemas(scope?: object): { name: string; description?: string }[] }
      | undefined
    if (tools === undefined) throw new Error('the tools service is not mounted')
    const schemas = tools.schemas(command.agent)
    const width = Math.max(0, ...schemas.map((schema) => schema.name.length))
    command.store.command(
      schemas
        .map(
          (schema) =>
            `  ${schema.name.padEnd(width)}  ${(schema.description ?? '').split('\n')[0] ?? ''}`,
        )
        .join('\n') || '  (none)',
    )
  },
}

/** Built-in verbs in help order; `/quit` aliases `/exit`. */
export const BUILTIN_VERBS: readonly Verb[] = [
  helpVerb,
  clearVerb,
  modelVerb,
  permissionsVerb,
  costVerb,
  sessionVerb,
  toolsVerb,
  exitVerb,
]

const ALIASES: Readonly<Record<string, string>> = {
  quit: 'exit',
  q: 'exit',
  h: 'help',
  '?': 'help',
}

/** Parse `/verb rest` into its parts. */
export function parseSlash(
  line: string,
): { name: string; args: string } | undefined {
  const match = /^\/([a-z?][a-z0-9_-]*)(?:\s+([\s\S]*))?$/iu.exec(line.trim())
  if (match === null) return undefined
  return { name: match[1]!.toLowerCase(), args: match[2] ?? '' }
}

/** Run a local shell command, streaming output into the transcript. */
export function runShell(line: string, command: CommandContext): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(line, {
      cwd: command.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: string[] = []
    child.stdout.on('data', (chunk: Buffer) =>
      chunks.push(chunk.toString('utf8')),
    )
    child.stderr.on('data', (chunk: Buffer) =>
      chunks.push(chunk.toString('utf8')),
    )
    child.on('error', (error) => {
      command.store.error(`shell: ${error.message}`)
      resolve()
    })
    child.on('close', (code) => {
      const output = chunks.join('').replace(/\n$/, '')
      if (output !== '') command.store.command(output)
      if (code !== 0) command.store.error(`shell: exit code ${code ?? 'null'}`)
      resolve()
    })
  })
}

/**
 * Dispatch one input line.
 * @returns `exit` to leave, `handled` when nothing reaches the model, `prompt` otherwise.
 */
export async function dispatchLine(
  line: string,
  command: CommandContext,
): Promise<Outcome> {
  const trimmed = line.trim()
  if (trimmed === '') return 'handled'
  if (trimmed.startsWith('!')) {
    command.store.user(trimmed)
    await runShell(trimmed.slice(1), command)
    return 'handled'
  }
  const slash = parseSlash(trimmed)
  if (slash === undefined) return 'prompt'
  const name = ALIASES[slash.name] ?? slash.name
  const verb = BUILTIN_VERBS.find((candidate) => candidate.name === name)
  command.store.user(trimmed)
  try {
    if (verb !== undefined) {
      await verb.run(slash.args, command)
      return name === 'exit' ? 'exit' : 'handled'
    }
    const commands = command.ctx.get('commands') as HarnessCommands | undefined
    const execution =
      commands === undefined
        ? undefined
        : await commands.execute(
            command.agent,
            trimmed,
            [],
            new AbortController().signal,
          )
    if (execution === undefined) {
      command.store.error(`unknown command: /${slash.name} (try /help)`)
      return 'handled'
    }
    if (execution.result.kind === 'error')
      command.store.error(execution.result.text ?? 'command failed')
    else if (
      execution.result.text !== undefined &&
      execution.result.text !== ''
    )
      command.store.command(execution.result.text)
    return 'handled'
  } catch (error) {
    command.store.error(error instanceof Error ? error.message : String(error))
    return 'handled'
  }
}
