/**
 * `dsc doctor [--json] [--strict]`: report where every runtime dependency
 * resolves from and whether the installation can boot each shipped profile,
 * as `metacodes doctor` does for its binaries. Checks never boot a tree.
 *
 * Each check carries a `status`: `ok`, `warn` (degraded but bootable), or
 * `fail` (a profile cannot boot). The process exits 1 on any `fail`, and
 * with `--strict` on any `warn` as well.
 * @module @dsc/cli/doctor
 */
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import {
  dscHomeDisplay,
  listProfiles,
  loadProfile,
  packageDirFromAnchor,
  profilesDir,
  readManifest,
  resolveDscHome,
  resolveProfileDir,
} from '@dsc/core'
import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { INSTALL_ANCHOR, NAME, PROFILE_TEMPLATES } from './install.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail'

/** One diagnostic row. */
export interface Check {
  name: string
  status: CheckStatus
  /** Where the subject resolved, when it is a file or directory. */
  resolved_path: string | null
  /** Version of the subject, when it has one. */
  version: string | null
  /** How the subject was found (`env`, `path`, `installation`, `profile`, `home`). */
  source: string | null
  detail: string
}

/** The full report. */
export interface DoctorReport {
  home: string
  install_anchor: string
  checks: Check[]
}

/** Minimum Node the DeepSeek Harness stack runs on. */
export const MIN_NODE_MAJOR = 22

function check(
  name: string,
  status: CheckStatus,
  detail: string,
  extra: Partial<Pick<Check, 'resolved_path' | 'version' | 'source'>> = {},
): Check {
  return {
    name,
    status,
    resolved_path: extra.resolved_path ?? null,
    version: extra.version ?? null,
    source: extra.source ?? null,
    detail,
  }
}

function which(
  command: string,
): { path: string; version: string | null } | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const located = spawnSync(finder, [command], { encoding: 'utf8' })
  if (located.status !== 0) return undefined
  const path = located.stdout
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
    ?.trim()
  if (path === undefined) return undefined
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const version =
    probe.status === 0 ? (probe.stdout.trim().split(/\r?\n/)[0] ?? null) : null
  return { path, version }
}

function nodeCheck(): Check {
  const major = Number(process.versions.node.split('.')[0])
  return major >= MIN_NODE_MAJOR
    ? check(
        'node',
        'ok',
        `Node ${process.version} meets the >=${MIN_NODE_MAJOR} floor`,
        {
          resolved_path: process.execPath,
          version: process.version,
          source: 'process',
        },
      )
    : check(
        'node',
        'fail',
        `Node ${process.version} is below the >=${MIN_NODE_MAJOR} floor`,
        {
          resolved_path: process.execPath,
          version: process.version,
          source: 'process',
        },
      )
}

function internalLoaderCheck(): Check {
  const loader = ModuleLoader.fromInternal()
  return loader === undefined
    ? check(
        'module_loader',
        'warn',
        'the Node internal module loader is unavailable (node-addon-require-builtin missing for this platform); bare plugin names resolve from the launcher instead of the profile directory',
      )
    : check(
        'module_loader',
        'ok',
        `Node internal module loader ${loader.version} hooked`,
        {
          source: 'installation',
        },
      )
}

function pnpmCheck(): Check {
  const pnpm = which('pnpm')
  return pnpm === undefined
    ? check(
        'pnpm',
        'warn',
        "pnpm is not on PATH; 'dsc plugin' cannot install profile plugins",
        {
          source: 'path',
        },
      )
    : check('pnpm', 'ok', 'pnpm resolves from PATH', {
        resolved_path: pnpm.path,
        version: pnpm.version,
        source: 'path',
      })
}

async function ripgrepCheck(): Promise<Check> {
  const dir = packageDirFromAnchor(INSTALL_ANCHOR, '@vscode/ripgrep')
  if (dir !== undefined) {
    const manifest = readManifest(NAME, join(dir, 'package.json'))
    try {
      const { rgPath } = (await import('@vscode/ripgrep')) as { rgPath: string }
      return existsSync(rgPath)
        ? check(
            'ripgrep',
            'ok',
            'the packaged ripgrep binary the grep tool uses is present',
            {
              resolved_path: rgPath,
              version: manifest.version ?? null,
              source: 'installation',
            },
          )
        : check(
            'ripgrep',
            'warn',
            `@vscode/ripgrep names ${rgPath}, which does not exist`,
            {
              resolved_path: rgPath,
              version: manifest.version ?? null,
              source: 'installation',
            },
          )
    } catch (error) {
      return check(
        'ripgrep',
        'warn',
        `@vscode/ripgrep is installed but resolves no binary for ${process.platform}-${process.arch}: ${error instanceof Error ? error.message : String(error)}`,
        {
          resolved_path: dir,
          version: manifest.version ?? null,
          source: 'installation',
        },
      )
    }
  }
  const rg = which('rg')
  return rg === undefined
    ? check(
        'ripgrep',
        'warn',
        'no packaged or PATH ripgrep; the grep tool will fail at first use',
        {
          source: 'path',
        },
      )
    : check('ripgrep', 'ok', 'ripgrep resolves from PATH', {
        resolved_path: rg.path,
        version: rg.version,
        source: 'path',
      })
}

function homeCheck(home: string): Check {
  if (!existsSync(home))
    return check(
      'home',
      'ok',
      `${dscHomeDisplay(home)} does not exist yet; the first boot creates it`,
      {
        resolved_path: home,
        source: process.env.DSC_HOME === undefined ? 'default' : 'env',
      },
    )
  try {
    accessSync(home, constants.W_OK)
  } catch {
    return check('home', 'fail', `${dscHomeDisplay(home)} is not writable`, {
      resolved_path: home,
      source: process.env.DSC_HOME === undefined ? 'default' : 'env',
    })
  }
  return check('home', 'ok', `${dscHomeDisplay(home)} is writable`, {
    resolved_path: home,
    source: process.env.DSC_HOME === undefined ? 'default' : 'env',
  })
}

function fallbackCheck(home: string): Check {
  const dir = join(profilesDir(home), 'node_modules')
  if (!existsSync(dir))
    return check(
      'module_fallback',
      'ok',
      'profiles/node_modules is created on the first boot',
      {
        resolved_path: dir,
        source: 'home',
      },
    )
  const dangling: string[] = []
  let links = 0
  const walk = (parent: string): void => {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name)
      if (entry.isSymbolicLink()) {
        links += 1
        const target = readlinkSync(path)
        if (!existsSync(target)) dangling.push(entry.name)
      } else if (entry.isDirectory() && entry.name.startsWith('@')) walk(path)
    }
  }
  walk(dir)
  return dangling.length === 0
    ? check('module_fallback', 'ok', `${links} installation links resolve`, {
        resolved_path: dir,
        source: 'home',
      })
    : check(
        'module_fallback',
        'warn',
        `${dangling.length} of ${links} links dangle (${dangling.slice(0, 5).join(', ')}); the next boot re-points them`,
        { resolved_path: dir, source: 'home' },
      )
}

function templateChecks(): Check[] {
  const seen = new Set<string>()
  const checks: Check[] = []
  for (const bundles of Object.values(PROFILE_TEMPLATES)) {
    for (const bundle of bundles) {
      if (seen.has(bundle)) continue
      seen.add(bundle)
      const dir = packageDirFromAnchor(INSTALL_ANCHOR, bundle)
      if (dir === undefined) {
        checks.push(
          check(
            `bundle:${bundle}`,
            'fail',
            'not resolvable from the installation',
            {
              source: 'installation',
            },
          ),
        )
        continue
      }
      const manifest = readManifest(NAME, join(dir, 'package.json'))
      const declared = manifest.dsc?.bundle ?? manifest.dsh?.bundle
      checks.push(
        declared === undefined
          ? check(
              `bundle:${bundle}`,
              'fail',
              'declares no dsc.bundle or dsh.bundle',
              {
                resolved_path: dir,
                version: manifest.version ?? null,
                source: 'installation',
              },
            )
          : check(`bundle:${bundle}`, 'ok', 'resolves from the installation', {
              resolved_path: dir,
              version: manifest.version ?? null,
              source: 'installation',
            }),
      )
    }
  }
  return checks
}

function profileChecks(home: string): Check[] {
  return listProfiles(home).map((name) => {
    const dir = resolveProfileDir(name, home)
    try {
      const profile = loadProfile(NAME, name, INSTALL_ANCHOR, home, {
        templates: PROFILE_TEMPLATES,
      })
      const layers = profile.layers.map(
        (layer) => `${layer.packageName}@${layer.version ?? '?'}`,
      )
      return check(`profile:${name}`, 'ok', `composes ${layers.join(' + ')}`, {
        resolved_path: dir,
        source: 'home',
      })
    } catch (error) {
      return check(
        `profile:${name}`,
        'fail',
        error instanceof Error
          ? error.message.replace(`${NAME}: `, '')
          : String(error),
        { resolved_path: dir, source: 'home' },
      )
    }
  })
}

function credentialsCheck(home: string): Check {
  const file = join(home, '.credentials.yaml')
  if (
    process.env.DEEPSEEK_API_KEY !== undefined &&
    process.env.DEEPSEEK_API_KEY !== ''
  )
    return check(
      'credentials',
      'ok',
      'DEEPSEEK_API_KEY is set in the launching environment',
      {
        source: 'env',
      },
    )
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777
    return process.platform !== 'win32' && (mode & 0o077) !== 0
      ? check(
          'credentials',
          'warn',
          `${file} is readable by others (mode ${mode.toString(8)})`,
          {
            resolved_path: file,
            source: 'home',
          },
        )
      : check('credentials', 'ok', 'the managed credential store exists', {
          resolved_path: file,
          source: 'home',
        })
  }
  return check(
    'credentials',
    'warn',
    "no DEEPSEEK_API_KEY and no credential store; run 'dsc login --api-key <key>' or export the key",
    { resolved_path: file, source: 'home' },
  )
}

/** Run every check. */
export async function diagnose(): Promise<DoctorReport> {
  const home = resolveDscHome()
  return {
    home,
    install_anchor: INSTALL_ANCHOR,
    checks: [
      nodeCheck(),
      internalLoaderCheck(),
      pnpmCheck(),
      await ripgrepCheck(),
      homeCheck(home),
      fallbackCheck(home),
      ...templateChecks(),
      ...profileChecks(home),
      credentialsCheck(home),
    ],
  }
}

/** The process exit code a report implies. */
export function exitCodeOf(report: DoctorReport, strict: boolean): number {
  if (report.checks.some((row) => row.status === 'fail')) return 1
  if (strict && report.checks.some((row) => row.status === 'warn')) return 1
  return 0
}

const MARK: Record<CheckStatus, string> = {
  ok: 'ok  ',
  warn: 'warn',
  fail: 'FAIL',
}

/** Render the report as text. */
export function renderDoctorText(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((row) => row.name.length))
  const lines = [`home ${report.home}`, `install ${report.install_anchor}`, '']
  for (const row of report.checks) {
    const where = [row.version, row.resolved_path]
      .filter((part) => part !== null)
      .join('  ')
    lines.push(`${MARK[row.status]}  ${row.name.padEnd(width)}  ${row.detail}`)
    if (where !== '') lines.push(`      ${''.padEnd(width)}  ${where}`)
  }
  return lines.join('\n') + '\n'
}

/** Render the report as one JSON document. */
export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, undefined, 2) + '\n'
}
