/**
 * `dsc plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder: initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the profile's
 * bundle list against the installed state. A dependency resolving to a
 * package that declares `dsc.bundle` or `dsh.bundle` joins the layer stack;
 * a removed or bundle-less dependency leaves it. Reconciling by installed
 * state, not by dependency diff, means `update` activates a package that
 * gained its bundle declaration in a newer version.
 * @module @dsc/cli/plugin
 */
import {
  bundleDeclarationOf,
  initProfile,
  profileBundlesOf,
  readManifest,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  withProfileBundles,
  writeProfileManifest,
  type PackageManifest,
} from '@dsc/core'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  INSTALL_ANCHOR,
  NAME,
  PROFILE_TEMPLATES,
} from './install.ts'

/** Whether a resolved dependency exports a profile patch, i.e. is a bundle. */
export function exportsPatch(
  packageName: string,
  profileDir: string,
  installAnchor: string = INSTALL_ANCHOR,
): boolean {
  let dir: string
  try {
    dir = resolveBundleDir(NAME, packageName, installAnchor, profileDir)
  } catch {
    return false
  }
  return (
    bundleDeclarationOf(readManifest(NAME, join(dir, 'package.json'))) !==
    undefined
  )
}

/**
 * Reconcile the profile's bundle list against the installed state. pnpm has
 * already written the real installed names and materialized the packages.
 * In-box bundles from the profile template are not dependencies and are never
 * touched. Warns once per newly-added bundle-less dependency.
 * @returns the bundle list after reconciliation.
 */
export function reconcilePlugins(
  before: PackageManifest,
  profileDir: string,
  installAnchor: string = INSTALL_ANCHOR,
  warn: (line: string) => void = (line) => void process.stderr.write(line),
): string[] {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const bundles = profileBundlesOf(after)
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir, installAnchor)
    if (isBundle && !bundles.includes(packageName)) {
      bundles.push(packageName)
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName))
      warn(
        `${NAME}: warning: ${packageName} declares no dsc.bundle or dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)\n`,
      )
  }
  const dependencySet = new Set(dependencies)
  for (const packageName of [...bundles]) {
    const wasDependency =
      beforeDeps.has(packageName) || dependencySet.has(packageName)
    const stillBundle =
      dependencySet.has(packageName) &&
      exportsPatch(packageName, profileDir, installAnchor)
    if (wasDependency && !stillBundle) {
      bundles.splice(bundles.indexOf(packageName), 1)
      changed = true
    }
  }
  if (changed)
    writeProfileManifest(profileDir, withProfileBundles(after, bundles))
  return bundles
}

/**
 * Rewrite relative filesystem specs against the user's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile.
 */
export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(
    argument,
  )
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}

/**
 * Run one `dsc plugin` invocation: init if needed, forward to pnpm, reconcile.
 * @returns the pnpm exit code.
 */
export function runPlugin(profile: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    initProfile(dir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  const result = spawnSync(
    'pnpm',
    args.map((argument) => anchorPathSpec(argument, process.cwd())),
    { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(
        `${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`,
      )
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) reconcilePlugins(before, dir)
  else {
    process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
    if (args.some((argument) => /^git\+|^github:|\.git(?:#|$)/.test(argument)))
      process.stderr.write(
        `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`,
      )
  }
  return exitCode
}
