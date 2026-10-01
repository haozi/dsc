/**
 * The terminal app's command-line provider: it parses the metacodes-style
 * session flags and publishes {@link TUI_SERVICE}. The terminal plugin and the
 * permission rows are ordinary consumers waiting for that service.
 * @module @dsc/bundle-tui/startup
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  isPermissionMode,
  parseCmdline,
  PERMISSION_MODES,
  resolvePermission,
  type ApprovalPolicy,
  type PermissionMode,
  type PermissionPreset,
  type SandboxMode,
} from '@dsc/core'
import { Command, InvalidArgumentError } from 'commander'

/** Stable cordis plugin name. */
export const name = 'dsc-tui-startup'

/** Services required before the options can be resolved. */
export const inject = ['cmdlineArgs']

/** Service name published here and injected by the terminal plugin. */
export const TUI_SERVICE = 'dscTui'

/** The terminal session's launch options. */
export interface TuiOptions {
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly permission: PermissionMode
  readonly sandboxMode: SandboxMode
  readonly approvalPolicy: ApprovalPolicy
  readonly preset: PermissionPreset
  /** Persisted session to resume; a fresh session when absent. */
  readonly resume: string | undefined
  /** Disable colors. */
  readonly theme: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dscTui?: TuiOptions
  }
}

function parsePermission(value: string): PermissionMode {
  if (isPermissionMode(value)) return value
  throw new InvalidArgumentError(
    `expected one of ${PERMISSION_MODES.join(' | ')}`,
  )
}

interface RawOptions {
  model?: string
  provider?: string
  permission: PermissionMode
  resume?: string
  theme: boolean
}

/** This app's command: flags, description, and help text. */
export function tuiCommand(): Command {
  return new Command()
    .name('dsc')
    .description('Start the interactive terminal session.')
    .helpOption('-h, --help', 'show this help')
    .option(
      '--model <model>',
      'model id for this session (default: the profile default)',
    )
    .option(
      '--provider <id>',
      'provider route for this session (default: the profile default)',
    )
    .option(
      '--permission <mode>',
      `${PERMISSION_MODES.join(' | ')}`,
      parsePermission,
      'default' as PermissionMode,
    )
    .option('--resume <session>', 'resume the persisted session with this id')
    .option('--no-theme', 'disable colors')
    .addHelpText(
      'after',
      `
Examples:
  dsc                                  start a fresh session in the current directory
  dsc --model deepseek-chat            pin the model for this session
  dsc --permission plan                start in plan mode (read-only sandbox)
  dsc --resume session-…               continue a persisted session
`,
    )
}

/** Resolve the raw flags into the published options. */
export function resolveOptions(raw: RawOptions): TuiOptions {
  if (raw.resume !== undefined && raw.resume.trim() === '')
    throw new Error('error: --resume needs a session id')
  return {
    model: raw.model,
    provider: raw.provider,
    permission: raw.permission,
    ...resolvePermission(raw.permission),
    resume: raw.resume,
    theme: raw.theme,
  }
}

/** Parse and provide the terminal options as an ordinary cordis service. */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((raw: RawOptions) => {
    let options: TuiOptions | undefined
    try {
      options = resolveOptions(raw)
    } catch (error) {
      program.error(error instanceof Error ? error.message : String(error))
    }
    if (options !== undefined) ctx.provide(TUI_SERVICE, options)
  })
  parseCmdline(ctx, program)
}
