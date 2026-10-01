/**
 * The one-shot app's command-line provider: it parses the metacodes-style
 * flags and publishes {@link HEADLESS_SERVICE}. The runner and the
 * permission rows are ordinary consumers waiting for that service.
 * @module @dsc/bundle-headless/startup
 */
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@dsc/core'
import { Command, InvalidArgumentError } from 'commander'
import {
  HEADLESS_SERVICE,
  PERMISSION_MODES,
  resolvePermission,
  type HeadlessOptions,
  type PermissionMode,
} from './options.ts'

/** Stable cordis plugin name. */
export const name = 'dsc-headless-startup'

/** Services required before the options can be resolved. */
export const inject = ['cmdlineArgs']

function parsePermission(value: string): PermissionMode {
  if ((PERMISSION_MODES as readonly string[]).includes(value))
    return value as PermissionMode
  throw new InvalidArgumentError(
    `expected one of ${PERMISSION_MODES.join(' | ')}`,
  )
}

interface RawOptions {
  print?: string
  json?: boolean
  streamJson?: boolean
  session?: string
  model?: string
  provider?: string
  permission: PermissionMode
  dumpPrompt?: boolean
}

/** This app's command: flags, description, and help text. */
export function headlessCommand(): Command {
  return new Command()
    .name('dsc -p')
    .description('Run one prompt headlessly, print the result, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[prompt...]', 'the prompt text; `-` reads it from stdin')
    .option(
      '-p, --print <prompt>',
      'the prompt (same as the positional; `-` reads stdin)',
    )
    .option(
      '--json',
      'emit one {"type":"result",...} NDJSON line instead of plain text',
    )
    .option(
      '--stream-json',
      'also stream per-event NDJSON lines live (text/thinking/tool/usage/turn)',
    )
    .option('--session <id>', 'resume the persisted session with this id')
    .option(
      '--model <model>',
      'model id for this run (default: the profile default)',
    )
    .option(
      '--provider <id>',
      'provider route for this run (default: the profile default)',
    )
    .option(
      '--permission <mode>',
      `${PERMISSION_MODES.join(' | ')}`,
      parsePermission,
      'default' as PermissionMode,
    )
    .option('--dump-prompt', 'print the assembled system prompt and exit')
    .addHelpText(
      'after',
      `
Examples:
  dsc -p "run the tests"                    answer one prompt and exit
  echo "run the tests" | dsc -p -           read the prompt from stdin
  dsc -p "fix it" --json                    print the final result as one NDJSON line
  dsc -p "fix it" --stream-json             stream text/tool/usage events as they happen
  dsc -p "continue" --session session-…     resume an existing session
  dsc -p "ship it" --permission auto        approve tool calls without asking
`,
    )
}

/**
 * Resolve the raw flags into the published options.
 * @throws when neither a positional prompt nor `-p` was given (unless `--dump-prompt`).
 */
export function resolveOptions(
  positional: readonly string[],
  raw: RawOptions,
): HeadlessOptions {
  const joined = positional.join(' ')
  const prompt = raw.print ?? joined
  if (raw.print !== undefined && joined.trim() !== '' && raw.print !== joined)
    throw new Error(
      'error: give the prompt once, either as -p <prompt> or positionally',
    )
  if (prompt.trim() === '' && raw.dumpPrompt !== true)
    throw new Error(
      'error: a prompt is required, for example: dsc -p "run the tests"',
    )
  if (raw.session !== undefined && raw.session.trim() === '')
    throw new Error('error: --session needs an id')
  const permission = resolvePermission(raw.permission)
  return {
    prompt,
    json: raw.json === true,
    streamJson: raw.streamJson === true,
    sessionId: raw.session,
    model: raw.model,
    provider: raw.provider,
    permission: raw.permission,
    ...permission,
    dumpPrompt: raw.dumpPrompt === true,
  }
}

/**
 * Parse and provide the one-shot options as an ordinary cordis service. A
 * rejected invocation (and `--help`) provides nothing.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action((positional: string[], raw: RawOptions) => {
    let options: HeadlessOptions | undefined
    try {
      options = resolveOptions(positional, raw)
    } catch (error) {
      program.error(error instanceof Error ? error.message : String(error))
    }
    if (options !== undefined) ctx.provide(HEADLESS_SERVICE, options)
  })
  parseCmdline(ctx, program)
}
