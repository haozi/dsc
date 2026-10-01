/**
 * The command line a launcher hands to the app it boots.
 *
 * The launcher parses only its own flags and provides everything after them
 * verbatim as the `cmdlineArgs` service, together with `appExit` (the request
 * to end the process) and `appReady` (fires once the tree settled). An app
 * plugin injects `cmdlineArgs`, parses its own flag family with commander, and
 * publishes the result as its own service. These are the exact slots DeepSeek
 * Harness app plugins (`@deepseek-ai/dsh-headless/startup`, the web app) read,
 * so they boot under dsc without modification.
 * @module @dsc/core/cmdline
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Command } from 'commander'

/** Immutable view of the app's arguments. */
export interface CmdlineArgs {
  get(): readonly string[]
}

/** Request process exit with a code; the launcher owns the actual teardown. */
export type AppExit = (code: number) => void

/** Subscribe to the moment the booted tree is fully active. */
export interface AppReady {
  onReady(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cmdlineArgs?: CmdlineArgs
    appExit?: AppExit
    appReady?: AppReady
  }
}

/** What a launcher supplies. */
export interface CmdlineHost {
  args: readonly string[]
  exit: AppExit
  ready?: AppReady
}

/** Service names, exported for hosts that provide them by hand. */
export const CMDLINE_ARGS_KEY = 'cmdlineArgs'
export const APP_EXIT_KEY = 'appExit'
export const APP_READY_KEY = 'appReady'

/**
 * Provide the command line, exit request, and readiness signal on a host
 * context before any tree entry mounts.
 */
export function provideCmdline(ctx: Context, host: CmdlineHost): void {
  const snapshot = Object.freeze([...host.args])
  ctx.provide(CMDLINE_ARGS_KEY, { get: () => snapshot })
  ctx.provide(APP_EXIT_KEY, host.exit)
  if (host.ready !== undefined) ctx.provide(APP_READY_KEY, host.ready)
}

/** A one-shot readiness latch: listeners added after commit fire at once. */
export function createAppReady(): { service: AppReady; commit(): void } {
  const listeners = new Set<() => void>()
  let committed = false
  return {
    service: {
      onReady(listener) {
        if (committed) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    commit() {
      if (committed) return
      committed = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/** The streams commander output goes to; tests substitute captures. */
export const cmdlineInternals = {
  stdout: process.stdout as { write(chunk: string): unknown },
  stderr: process.stderr as { write(chunk: string): unknown },
}

/** Whether a thrown value is commander's control-flow error (any commander copy). */
export function isCommanderError(
  error: unknown,
): error is { code: string; exitCode: number; message: string } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return (
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('commander.') &&
    typeof candidate.exitCode === 'number'
  )
}

function hasAction(command: Command): boolean {
  if (
    typeof (command as unknown as { _actionHandler?: unknown })
      ._actionHandler === 'function'
  )
    return true
  return command.commands.some(hasAction)
}

function configureExitAndOutput(command: Command): void {
  command.exitOverride().configureOutput({
    writeOut: (text) => void cmdlineInternals.stdout.write(text),
    writeErr: (text) => void cmdlineInternals.stderr.write(text),
  })
  for (const child of command.commands) configureExitAndOutput(child)
}

/**
 * Parse the launcher's argument snapshot with an app's commander program.
 * Help, version, and rejected arguments are terminal: commander prints and
 * the helper requests `appExit`; the action never runs on those paths.
 * @throws when the launcher provided no command line, or no command declares an action.
 */
export function parseCmdline(ctx: Context, program: Command): void {
  const args = ctx.get(CMDLINE_ARGS_KEY) as CmdlineArgs | undefined
  const exit = ctx.get(APP_EXIT_KEY) as AppExit | undefined
  if (args === undefined || exit === undefined)
    throw new Error(
      `${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`,
    )
  if (!hasAction(program))
    throw new Error(
      `${program.name()}: no command in the program declares an action; parseCmdline runs the invoked command's action on a successful parse`,
    )
  configureExitAndOutput(program)
  try {
    program.parse([...args.get()], { from: 'user' })
  } catch (error) {
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }
}
