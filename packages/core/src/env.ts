/**
 * Layered `.env` loading and the immutable launch-environment snapshot.
 *
 * Precedence is inherited process environment, then the invoking directory's
 * `.env`, then the dsc home's `.env`. Both files are validated before either
 * is applied; a discovered file may never set a variable that decides how the
 * process starts, where its code loads from, or how it reaches the network.
 * The snapshot records which layer supplied each value and is provided to the
 * plugin tree as the `launchEnvironment` service, the slot DeepSeek Harness
 * plugins read through `launchEnvironmentOf(ctx)`.
 * @module @dsc/core/env
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { resolveDscHome } from './home.ts'

/** Layer names, most trusted first. */
export type EnvSource = 'process' | 'project-env' | 'user-env'

const SOURCE_ORDER: readonly EnvSource[] = [
  'process',
  'project-env',
  'user-env',
]

/** One environment layer: where it came from and what it holds. */
export interface EnvLayer {
  source: EnvSource
  /** The file the layer was read from; absent for the process layer. */
  path?: string
  values: Readonly<Record<string, string | undefined>>
}

/** A resolved variable with its provenance. */
export interface EnvLookup {
  value: string
  source: EnvSource
  path?: string
}

/** Immutable, provenance-preserving view of this run's environment. */
export interface LaunchEnvironment {
  /** Resolve `name` across every layer in trust order. */
  get(name: string): EnvLookup | undefined
  /** Resolve `name` across only the named layers, still in trust order. */
  getFrom(name: string, sources: readonly EnvSource[]): EnvLookup | undefined
}

/** Context slot the launcher fills before any config entry mounts. */
export const LAUNCH_ENVIRONMENT_KEY = 'launchEnvironment'

/** Windows compares environment names case-insensitively; nothing else does. */
function lookupKey(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/**
 * Build the snapshot from its layers.
 * @param layers - layers in any order; lookups follow the canonical trust order.
 */
export function createLaunchEnvironment(
  layers: readonly EnvLayer[],
): LaunchEnvironment {
  const bySource = new Map<
    EnvSource,
    { path?: string; values: Map<string, string> }
  >()
  for (const layer of layers) {
    const values = new Map<string, string>()
    for (const [name, value] of Object.entries(layer.values)) {
      if (value !== undefined) values.set(lookupKey(name), value)
    }
    bySource.set(layer.source, {
      ...(layer.path === undefined ? {} : { path: layer.path }),
      values,
    })
  }
  const getFrom = (
    name: string,
    sources: readonly EnvSource[],
  ): EnvLookup | undefined => {
    const key = lookupKey(name)
    for (const source of SOURCE_ORDER) {
      if (!sources.includes(source)) continue
      const layer = bySource.get(source)
      const value = layer?.values.get(key)
      if (value === undefined) continue

      return {
        value,
        source,
        ...(layer?.path === undefined ? {} : { path: layer.path }),
      }
    }
    return undefined
  }
  return {
    get: (name) => getFrom(name, SOURCE_ORDER),
    getFrom,
  }
}

/** Exact names no discovered `.env` may set. */
const BOOTSTRAP_NAMES = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SHELL',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PERL5OPT',
  'PERL5LIB',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

/** Name prefixes no discovered `.env` may set. */
const BOOTSTRAP_PREFIXES = ['DSC_', 'DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

/**
 * Whether only the inherited process environment may supply a variable.
 * @param name - the variable name.
 */
export function isBootstrapOnly(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    BOOTSTRAP_NAMES.has(upper) ||
    BOOTSTRAP_PREFIXES.some((prefix) => upper.startsWith(prefix))
  )
}

/** Diagnostic sink for one-line misconfiguration notices. */
export type WarnSink = (line: string) => void

const stderrWarn: WarnSink = (line) => void process.stderr.write(line)

/**
 * Parse one directory's `.env` without applying it.
 * @param binName - diagnostic prefix.
 * @param dir - the directory whose `.env` to read.
 * @param warn - sink for the unreadable-file notice.
 * @returns the parsed layer, or `undefined` when the file is absent or unreadable.
 * @throws when the file sets a bootstrap-only name.
 */
export function readEnvLayer(
  binName: string,
  dir: string,
  warn: WarnSink = stderrWarn,
): { path: string; values: Record<string, string> } | undefined {
  const path = resolve(dir, '.env')
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    return undefined
  }
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (typeof value === 'string') values[name] = value
  }
  for (const name of Object.keys(values)) {
    if (!isBootstrapOnly(name)) continue
    throw new Error(
      `${binName}: ${path} sets "${name}", which only the launching environment may set; export ${name} instead of putting it in a .env file`,
    )
  }
  return { path, values }
}

/**
 * Load the inherited > project `.env` > home `.env` layers into the process
 * environment (never replacing inherited values) and return the snapshot.
 * @param binName - diagnostic prefix.
 * @param cwd - the invoking directory (project layer).
 * @param warn - sink for one-line diagnostics.
 * @throws when either file sets a bootstrap-only variable.
 */
export function loadLayeredEnv(
  binName: string,
  cwd: string = process.cwd(),
  warn: WarnSink = stderrWarn,
): LaunchEnvironment {
  const home = resolveDscHome()
  const inherited: Record<string, string | undefined> = { ...process.env }
  const project = readEnvLayer(binName, cwd, warn)
  const user =
    home === resolve(cwd) ? undefined : readEnvLayer(binName, home, warn)
  for (const layer of [project, user]) {
    if (layer === undefined) continue
    for (const [name, value] of Object.entries(layer.values)) {
      if (process.env[name] === undefined) process.env[name] = value
    }
  }
  return createLaunchEnvironment([
    { source: 'process', values: inherited },
    ...(project === undefined
      ? []
      : [
          {
            source: 'project-env' as const,
            path: project.path,
            values: project.values,
          },
        ]),
    ...(user === undefined
      ? []
      : [
          { source: 'user-env' as const, path: user.path, values: user.values },
        ]),
  ])
}
