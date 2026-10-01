/**
 * The Loader boot sequence shared by every dsc surface.
 *
 * `boot()` creates the root context, exposes the home-path resolvers to
 * config expressions, installs the cordis Loader, lets the launcher provide
 * its host services, mounts the profile's root `cordis.yml` as a
 * `cordis:include` entry with the composed patch stack, waits for the tree to
 * settle, and audits that every enabled entry activated. Failures dispose the
 * partial tree and rethrow with the plugin's original stack.
 * @module @dsc/core/boot
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import { Include, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader, { type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dscHomePath } from './home.ts'
import { loadOptionalPatches } from './patches.ts'

/** Context slot naming the home-path resolver for `!!js` config expressions. */
export const DSC_HOME_PATH_KEY = 'dscHomePath'

/** The DeepSeek Harness spelling of the same resolver, read by dsh bundles. */
export const DSH_HOME_PATH_KEY = 'dshHomePath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dscHomePath?: (...segments: string[]) => string
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Mirrors of cordis's const enum, which has no runtime object. */
export const FIBER_PENDING = 0
export const FIBER_ACTIVE = 2
export const FIBER_FAILED = 3

const bootstrapIncludes = new WeakMap<Context, Entry>()

/** The root include entry `boot()` mounted for `ctx`, when still present. */
export function rootIncludeOf(ctx: Context): Entry | undefined {
  return bootstrapIncludes.get(ctx)
}

/**
 * Mount the root include that carries the whole profile tree. The patch list
 * is cloned first: the include pushes inserted rows into the tree by
 * reference, so a later id-targeted patch would otherwise mutate the
 * caller's objects and hide the change from the Loader's diff.
 * @returns the created entry, or `undefined` when the tree was disposed mid-flight.
 */
export async function mountRootInclude(
  ctx: Context,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[] = [],
): Promise<Entry | undefined> {
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const includeId = await ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: {
      path: pathToFileURL(absoluteConfigPath).href,
      ...(patches.length > 0 ? { patches: structuredClone([...patches]) } : {}),
    },
  } as never)
  const loader = ctx.get('loader') as Loader | undefined
  if (loader === undefined) return undefined
  const entry = loader.resolve(includeId)
  bootstrapIncludes.set(ctx, entry)
  return entry
}

/** Render a thrown plugin value without discarding an Error's original stack. */
export function formatActivationError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/**
 * Reject a settled Loader tree when an enabled entry failed to import, failed
 * to activate, or remains pending on a missing service.
 */
export async function assertEntriesActivated(
  ctx: Context,
  binName: string,
): Promise<void> {
  const loader = ctx.loader
  const unresolved = [...loader.entries()].filter(
    (entry) => entry.fiber === undefined && !entry.disabled,
  )
  if (unresolved.length > 0) {
    const names = unresolved.map((entry) => entry.options.name).join(', ')
    throw new Error(
      `${binName}: plugin(s) failed to load: ${names}; these plugin(s) could not be resolved (see the error(s) logged above)`,
    )
  }
  const failures: string[] = []
  for (const entry of loader.entries()) {
    const fiber = entry.fiber as Fiber | undefined
    if (fiber === undefined || entry.disabled) continue
    const state = fiber.state as number
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try {
        await fiber.await()
      } catch (error) {
        failures.push(`${entry.options.name}: ${formatActivationError(error)}`)
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(
        (service) => fiber.ctx.get(service) === undefined,
      )
      const noun = missing.length === 1 ? 'service' : 'services'
      failures.push(
        `${entry.options.name}: pending (waiting for ${noun}: ${missing.join(', ') || 'unknown'})`,
      )
    } else failures.push(`${entry.options.name}: fiber state ${String(state)}`)
  }
  if (failures.length > 0) {
    const noun = failures.length === 1 ? 'entry' : 'entries'
    throw new Error(
      `${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join('\n')}`,
    )
  }
}

/** Host setup run after the Loader is installed and before any entry mounts. */
export type PrepareHost = (ctx: Context) => void | Promise<void>

/**
 * Boot the Loader against `absoluteConfigPath` and return once the tree settles.
 * @param binName - diagnostic prefix.
 * @param absoluteConfigPath - the root entry list to include.
 * @param patches - the composed patch stack applied over it.
 * @param prepare - host services to provide before the tree mounts.
 * @throws after disposing the partial context when preparation or loading fails.
 */
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[],
  prepare?: PrepareHost,
): Promise<Context> {
  const ctx = new Context()
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
    ctx.provide(DSC_HOME_PATH_KEY, dscHomePath)
    ctx.provide(DSH_HOME_PATH_KEY, dscHomePath)
    ctx.on(
      'internal/update',
      (_config: unknown, _noSave: unknown, next: () => unknown) => {
        Promise.resolve(next()).catch((error: unknown) => {
          ctx.logger.error(error)
        })
      },
      { global: true, prepend: true },
    )
    await ctx.plugin(Loader)
    await prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absoluteConfigPath, patches)
    await (ctx.get('loader') as Loader | undefined)?.await()
    if (ctx.get('loader') === undefined) return ctx
    await assertEntriesActivated(ctx, binName)
    return ctx
  } catch (cause) {
    await ctx.fiber.dispose()
    const detail = cause instanceof Error ? cause.message : String(cause)
    let deepest: unknown = cause
    const seen = new Set<unknown>()
    while (
      deepest instanceof Error &&
      !seen.has(deepest) &&
      deepest.cause !== undefined
    ) {
      seen.add(deepest)
      deepest = deepest.cause
    }
    const stack =
      deepest instanceof Error && deepest !== cause
        ? `\n${deepest.stack ?? deepest.message}`
        : ''
    throw new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause })
  }
}

/** Grace before a fatal exit stops waiting for the terminal owner's release. */
export const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

/**
 * Turn a late unhandled plugin rejection into one labelled diagnostic and
 * `exit(1)`. `release` lets a terminal-owning surface restore the terminal
 * first, bounded by {@link FAIL_LOUD_RELEASE_TIMEOUT_MS}.
 * @returns the uninstaller.
 */
export function installFailLoud(
  binName: string,
  proc: Pick<NodeJS.Process, 'on' | 'off' | 'exit' | 'stderr'> = process,
  release?: () => void | Promise<void>,
): () => void {
  let exiting = false
  const handler = (err: unknown): void => {
    if (exiting) return
    exiting = true
    proc.stderr.write(
      `${binName}: fatal load failure: ${formatActivationError(err)}\n`,
    )
    if (release === undefined) {
      proc.exit(1)
      return
    }
    void (async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          (async () => release())(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FAIL_LOUD_RELEASE_TIMEOUT_MS)
          }),
        ])
      } catch {
        // the pending fatal exit already owns the outcome
      }
      clearTimeout(timer)
      proc.exit(1)
    })()
  }
  proc.on('unhandledRejection', handler)
  return () => void proc.off('unhandledRejection', handler)
}

/** Maximum grace the application tree gets to dispose before a forced exit. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

/** Bounded, escalating process shutdown. */
export interface ProcessShutdown {
  /** Normal exit: dispose, then record the exit code. Calls coalesce. */
  shutdown(code: number): Promise<void>
  /** Signal exit: dispose then force-exit; a repeated call exits at once. */
  interrupt(code: number): void
}

/**
 * Create one process-exit controller around an application disposer.
 * @param dispose - whole-application teardown.
 * @param forceExit - immediate exit, replaceable by tests.
 * @param complete - records the natural completion code, replaceable by tests.
 * @param timeoutMs - grace before forced exit.
 */
export function createProcessShutdown(
  dispose: () => Promise<void>,
  forceExit: (code: number) => void = (code) => process.exit(code),
  complete: (code: number) => void = (code) => {
    process.exitCode = code
  },
  timeoutMs: number = PROCESS_SHUTDOWN_TIMEOUT_MS,
): ProcessShutdown {
  let pending: Promise<void> | undefined
  let timeout: NodeJS.Timeout | undefined
  let completed = false
  let forceExited = false
  const clearExitTimeout = (): void => {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  const forceExitOnce = (code: number): void => {
    if (forceExited) return
    forceExited = true
    clearExitTimeout()
    forceExit(code)
  }
  const completeOnce = (code: number): void => {
    if (completed || forceExited) return
    completed = true
    clearExitTimeout()
    complete(code)
  }
  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    timeout = setTimeout(() => forceExitOnce(code), timeoutMs)
    pending = Promise.resolve()
      .then(dispose)
      .then(
        () => (forceAfterDispose ? forceExitOnce(code) : completeOnce(code)),
        () => forceExitOnce(code),
      )
    return pending
  }
  return {
    shutdown: (code) => start(code, false),
    interrupt(code) {
      if (pending !== undefined) {
        forceExitOnce(code)
        return
      }
      void start(code, true)
    },
  }
}

/** Options for {@link watchPatchFile}. */
export interface WatchPatchOptions {
  binName: string
  /** The patch file to watch (may not exist yet). */
  filename: string
  /** Recompose the full patch stack after a change. */
  compose(): PatchOptions[]
  /** Debounce window for bursts of filesystem events. */
  debounceMs?: number
  /** Sink for apply failures; defaults to the root logger. */
  warn?: (message: string) => void
}

/**
 * Keep a user patch layer live: on change, recompose the stack and update the
 * root include's `patches` so the Loader diffs the tree in place. Uses a
 * native directory watcher, so the file may be created or replaced atomically.
 * @returns a disposer that stops watching.
 */
export function watchPatchFile(
  ctx: Context,
  options: WatchPatchOptions,
): () => void {
  const entry = bootstrapIncludes.get(ctx)
  if (entry === undefined)
    throw new Error(
      `${options.binName}: patch-layer watching requires the root include entry`,
    )
  const dir = dirname(options.filename)
  const warn =
    options.warn ?? ((message: string) => ctx.logger('dsc').warn(message))
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  const apply = (): void => {
    timer = undefined
    void (async () => {
      try {
        const { patches: _previous, ...includeConfig } = entry.options
          .config as {
          patches?: PatchOptions[]
          [key: string]: unknown
        }
        void _previous
        // Only a readable layer reaches the tree; a half-written file is skipped.
        loadOptionalPatches(options.binName, options.filename)
        await entry.update({
          config: {
            ...includeConfig,
            patches: structuredClone(options.compose()),
          },
        })
      } catch (error) {
        warn(
          `${options.binName}: ${options.filename}: ${formatActivationError(error)}`,
        )
      }
    })()
  }
  try {
    watcher = watch(dir, { persistent: false }, (_event, changed) => {
      if (
        changed !== null &&
        changed !== undefined &&
        changed !== basenameOf(options.filename)
      )
        return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(apply, options.debounceMs ?? 100)
    })
    watcher.on('error', (error) =>
      warn(
        `${options.binName}: watcher for ${options.filename} failed: ${String(error)}`,
      ),
    )
  } catch (error) {
    warn(
      `${options.binName}: cannot watch ${options.filename}: ${String(error)}`,
    )
  }
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    watcher?.close()
  }
}

function basenameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}
