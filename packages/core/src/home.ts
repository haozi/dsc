/**
 * Filesystem roots for dsc user data.
 *
 * dsc keeps every profile, session, credential, and setting under one home:
 * `$DSC_HOME`, defaulting to `~/.dsc`. Plugins written for DeepSeek Harness
 * resolve their own home through `$DSH_HOME`, so {@link bridgeDshHome}
 * points that variable at the dsc home before any plugin loads — a dsh plugin
 * installed into a dsc profile then stores its state beside dsc's own.
 * @module @dsc/core/home
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory name of the default dsc home under the OS home. */
export const DSC_HOME_DIR_NAME = '.dsc'

/** Environment variable overriding the dsc home. */
export const DSC_HOME_ENV = 'DSC_HOME'

/** The DeepSeek Harness home variable dsh plugins read on their own. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** User-facing spelling of the default home. */
export const DEFAULT_DSC_HOME_DISPLAY = `~/${DSC_HOME_DIR_NAME}`

/**
 * Expand a leading `~` against the OS home directory.
 * @param path - a configured path that may start with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the input when it carries no tilde prefix.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\'))
    return join(homedir(), path.slice(2))
  return path
}

/** The default dsc home (`~/.dsc`). */
export function defaultDscHome(): string {
  return join(homedir(), DSC_HOME_DIR_NAME)
}

/**
 * Resolve the dsc home. Precedence: an explicit value, `$DSC_HOME`, then
 * `~/.dsc`. A blank `$DSC_HOME` counts as unset so an empty override never
 * resolves to the working directory.
 * @param configured - explicit override with the highest precedence.
 * @param env - environment to read `DSC_HOME` from.
 * @returns the absolute, normalized home path.
 */
export function resolveDscHome(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[DSC_HOME_ENV]
  const chosen =
    configured ??
    (fromEnv !== undefined && fromEnv.trim() !== ''
      ? fromEnv
      : defaultDscHome())
  return resolve(expandHomePath(chosen))
}

/**
 * Join segments onto the resolved dsc home. Exposed to config expressions as
 * `dscHomePath(...)` and, for dsh bundles, under the `dshHomePath` alias.
 * @param segments - path segments; none returns the home itself.
 */
export function dscHomePath(...segments: string[]): string {
  return join(resolveDscHome(), ...segments)
}

/**
 * Describe a resolved home symbolically: `~/.dsc` for the default, otherwise
 * `$DSC_HOME`. Never prints a machine path.
 * @param resolvedHome - the value {@link resolveDscHome} returned.
 */
export function dscHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultDscHome())
    ? DEFAULT_DSC_HOME_DISPLAY
    : `$${DSC_HOME_ENV}`
}

/**
 * Point `$DSH_HOME` at the dsc home when the launching environment did not
 * set it. Plugins from the DeepSeek Harness ecosystem call their own
 * `resolveDshHome()` for settings, credentials, and session roots; without
 * this bridge they would scatter state into `~/.dsh` while dsc profiles live
 * in `~/.dsc`. An explicit `$DSH_HOME` is respected so an operator can
 * deliberately share one home between dsh and dsc.
 * @param env - the environment to mutate (the process environment).
 * @returns the home the dsh variable now names.
 */
export function bridgeDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveDscHome(undefined, env)
  const existing = env[DSH_HOME_ENV]
  if (existing === undefined || existing.trim() === '') env[DSH_HOME_ENV] = home
  return env[DSH_HOME_ENV] as string
}
