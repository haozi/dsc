/**
 * Profile discovery, initialization, bundle resolution, and layer composition.
 *
 * A profile is `$DSC_HOME/profiles/<name>/` holding:
 *
 * - `package.json` — out-of-tree plugin dependencies plus the profile
 *   manifest `dsc.profile.bundles` (ordered layer list);
 * - `cordis.yml` — the empty root entry list the tree patches over;
 * - `cordis.patch.yml` — the user's own patch layer, applied after every
 *   bundle layer and hot-reloaded on long-lived surfaces;
 * - `pnpm-workspace.yaml` — hoisted pnpm settings for `dsc plugin add`.
 *
 * A bundle is an npm package whose manifest declares a patch file under
 * `dsc.bundle.patch` — or, for packages written for DeepSeek Harness,
 * `dsh.bundle.patch`. Both spellings are honored everywhere so a dsh plugin
 * installs into a dsc profile unchanged.
 *
 * Module resolution is two-anchor: a bundle resolves first from the dsc
 * installation (the launcher's own package), then from the profile directory.
 * The flat fallback `$DSC_HOME/profiles/node_modules` holds one symlink per
 * package in the installation's dependency closure, so every in-box plugin is
 * Node-resolvable from any profile through the ordinary parent walk.
 * @module @dsc/core/profile
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { resolveDscHome } from './home.ts'
import { loadOverlayPatches, type PatchOptions } from './patches.ts'

/** Directory under the home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** The empty root entry list every profile tree patches over. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The user patch layer inside a profile directory. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The home-level user layer applied over every profile. */
export const HOME_PATCH_FILENAME = 'cordis.patch.yml'

/** Manifest namespaces consulted for profile and bundle declarations, in order. */
export const MANIFEST_NAMESPACES = ['dsc', 'dsh'] as const

export type ManifestNamespace = (typeof MANIFEST_NAMESPACES)[number]

/** Bundle declaration in a package manifest. */
export interface BundleDeclaration {
  /** Patch file(s) relative to the package root, applied in order. */
  patch: string | string[]
}

/** Profile declaration in a profile manifest. */
export interface ProfileDeclaration {
  bundles?: string[]
}

/** The subset of `package.json` dsc reads and writes. */
export interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsc?: { profile?: ProfileDeclaration; bundle?: BundleDeclaration }
  dsh?: { profile?: ProfileDeclaration; bundle?: BundleDeclaration }
  [key: string]: unknown
}

/** One resolved bundle layer. */
export interface BundleLayer {
  packageName: string
  packageDir: string
  version: string | undefined
  /** The bundle's patch files, in application order. */
  patchPaths: string[]
  /** Every patch file's entries, concatenated in order. */
  patches: PatchOptions[]
}

/** A loaded profile. */
export interface Profile {
  name: string
  dir: string
  manifest: PackageManifest
  layers: BundleLayer[]
  patchPath: string
  /** The user layer; empty when skipped or absent. */
  patches: PatchOptions[]
}

export const PROFILE_ROOT_CONFIG = `# dsc profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsc.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsc profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Resolve a profile's directory under the home.
 * @throws on a name that would escape `profiles/` or collide with `node_modules`.
 */
export function resolveProfileDir(
  name: string,
  home: string = resolveDscHome(),
): string {
  if (
    name === '' ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..' ||
    name === 'node_modules'
  )
    throw new Error(`dsc: invalid profile name ${JSON.stringify(name)}`)
  return join(home, PROFILES_DIR, name)
}

/** The directory holding every profile. */
export function profilesDir(home: string = resolveDscHome()): string {
  return join(home, PROFILES_DIR)
}

/**
 * Initialize a profile directory: manifest, root config, empty user layer, and
 * pnpm settings. Existing files are never touched, so re-running is a no-op.
 * @param dir - the profile directory.
 * @param bundles - the initial `dsc.profile.bundles` list.
 */
export function initProfile(dir: string, bundles: readonly string[]): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: PackageManifest = {
      name: `dsc-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsc: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
  const rootPath = join(dir, PROFILE_ROOT_FILENAME)
  if (!existsSync(rootPath)) writeFileSync(rootPath, PROFILE_ROOT_CONFIG)
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath))
    writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

/** Read a package manifest at `path`, failing loud with a labelled error. */
export function readManifest(binName: string, path: string): PackageManifest {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `${binName}: failed to read manifest ${path}: ${String(error)}`,
    )
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${binName}: manifest ${path} must hold a JSON object`)
  return parsed as PackageManifest
}

/** Read a profile's `package.json`. */
export function readProfileManifest(
  binName: string,
  dir: string,
): PackageManifest {
  return readManifest(binName, join(dir, 'package.json'))
}

/** Write a profile's manifest back (2-space JSON, trailing newline). */
export function writeProfileManifest(
  dir: string,
  manifest: PackageManifest,
): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(manifest, undefined, 2) + '\n',
  )
}

/**
 * The bundle a manifest declares, from `dsc.bundle` or `dsh.bundle`.
 * @returns the declaration and its namespace, or `undefined` for a plain package.
 */
export function bundleDeclarationOf(
  manifest: PackageManifest,
): { namespace: ManifestNamespace; bundle: BundleDeclaration } | undefined {
  for (const namespace of MANIFEST_NAMESPACES) {
    const bundle = manifest[namespace]?.bundle
    if (bundle === undefined) continue
    const declared = bundle.patch as unknown
    if (
      typeof declared === 'string' ||
      (Array.isArray(declared) &&
        declared.every((file) => typeof file === 'string'))
    )
      return { namespace, bundle }
  }
  return undefined
}

/** A bundle declaration's patch files, in application order. */
export function bundlePatchFiles(bundle: BundleDeclaration): string[] {
  return typeof bundle.patch === 'string' ? [bundle.patch] : [...bundle.patch]
}

/**
 * The ordered bundle list a profile manifest declares, from
 * `dsc.profile.bundles` or `dsh.profile.bundles`.
 */
export function profileBundlesOf(manifest: PackageManifest): string[] {
  for (const namespace of MANIFEST_NAMESPACES) {
    const bundles = manifest[namespace]?.profile?.bundles
    if (Array.isArray(bundles)) return [...bundles]
  }
  return []
}

/**
 * Write the bundle list back under the namespace the manifest already uses
 * (`dsc` for new profiles; `dsh` for a profile directory copied from dsh).
 */
export function withProfileBundles(
  manifest: PackageManifest,
  bundles: readonly string[],
): PackageManifest {
  const namespace: ManifestNamespace =
    manifest.dsc?.profile !== undefined || manifest.dsh?.profile === undefined
      ? 'dsc'
      : 'dsh'
  return {
    ...manifest,
    [namespace]: {
      ...manifest[namespace],
      profile: { ...manifest[namespace]?.profile, bundles: [...bundles] },
    },
  }
}

/**
 * Resolve a package's root directory from one anchor without depending on the
 * package exporting `./package.json`: probe Node's own `node_modules` lookup
 * order for a directory holding the named manifest.
 */
export function packageDirFromAnchor(
  anchor: string,
  packageName: string,
): string | undefined {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ??
    []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Resolve one bundle package's directory: installation anchor first, then the
 * profile directory. Installation-first is the contract that in-box bundles
 * always come from the same installation as the running dsc.
 * @param binName - diagnostic prefix.
 * @param packageName - the bundle's package name.
 * @param installAnchor - absolute path of the dsc app's `package.json`.
 * @param profileDir - the profile directory (second anchor).
 */
export function resolveBundleDir(
  binName: string,
  packageName: string,
  installAnchor: string,
  profileDir: string,
): string {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, packageName)
    if (dir !== undefined) return dir
  }
  throw new Error(
    `${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} from the dsc installation or ${profileDir}; run 'dsc plugin --profile ${basename(profileDir)} install' if its dependency is not installed`,
  )
}

/** Ensure `link` is a symlink to `target`, replacing a wrong or dangling link. */
function ensureSymlink(link: string, target: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink())
      throw new Error(
        `dsc: ${link} exists and is not a symlink; remove it so dsc can manage the installation fallback`,
      )
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  try {
    symlinkSync(target, link, 'junction')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'EEXIST' ||
      !lstatSync(link).isSymbolicLink() ||
      readlinkSync(link) !== target
    )
      throw error
  }
}

/**
 * Maintain the flat module fallback `$DSC_HOME/profiles/node_modules`: one
 * symlink per package in the dsc app's resolvable dependency closure (BFS over
 * `dependencies` and `peerDependencies` from the install anchor), each
 * pointing at its real location. Idempotent; moved installations are
 * re-pointed.
 * @param installAnchor - absolute path of the dsc app's `package.json`.
 * @param home - the dsc home.
 * @returns the number of links maintained.
 */
export function healProfilesModuleFallback(
  installAnchor: string,
  home: string = resolveDscHome(),
): number {
  const modulesDir = join(profilesDir(home), 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const appManifest = readManifest('dsc', installAnchor)
  const links = new Map<string, string>()
  if (appManifest.name !== undefined)
    links.set(appManifest.name, dirname(installAnchor))
  const queue: { anchor: string; manifest: PackageManifest }[] = [
    { anchor: installAnchor, manifest: appManifest },
  ]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const names = [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ]
    for (const dep of names) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifestPath = join(dir, 'package.json')
      queue.push({
        anchor: manifestPath,
        manifest: readManifest('dsc', manifestPath),
      })
    }
  }
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureSymlink(link, target)
  }
  return links.size
}

/** Options for {@link loadProfile}. */
export interface LoadProfileOptions {
  /** `false` skips `cordis.patch.yml` so a recovery dump cannot fail on it. */
  userLayer?: boolean
  /** Shipped templates auto-initialized on first use, by profile name. */
  templates?: Readonly<Record<string, readonly string[]>>
}

/**
 * Load a profile: resolve every declared bundle to its patch layer and parse
 * the profile's own patch file. A listed bundle without a bundle declaration
 * fails loud — naming a bundle-less package as a layer is a misconfiguration.
 * @param binName - diagnostic prefix.
 * @param name - the profile name.
 * @param installAnchor - absolute path of the dsc app's `package.json`.
 * @param home - the dsc home.
 * @param options - user-layer switch and shipped templates.
 */
export function loadProfile(
  binName: string,
  name: string,
  installAnchor: string,
  home: string = resolveDscHome(),
  options: LoadProfileOptions = {},
): Profile {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = options.templates?.[name]
    if (template === undefined)
      throw new Error(
        `${binName}: profile ${JSON.stringify(name)} does not exist; create it with '${binName} plugin --profile ${name} add <package>'`,
      )
    initProfile(dir, template)
  }
  const manifest = readProfileManifest(binName, dir)
  const layers = profileBundlesOf(manifest).map((packageName): BundleLayer => {
    const packageDir = resolveBundleDir(
      binName,
      packageName,
      installAnchor,
      dir,
    )
    const bundleManifest = readManifest(
      binName,
      join(packageDir, 'package.json'),
    )
    const declared = bundleDeclarationOf(bundleManifest)
    if (declared === undefined)
      throw new Error(
        `${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsc.bundle or dsh.bundle in its package.json`,
      )
    const patchPaths = bundlePatchFiles(declared.bundle).map((file) =>
      join(packageDir, file),
    )
    return {
      packageName,
      packageDir,
      version: bundleManifest.version,
      patchPaths,
      patches: patchPaths.flatMap((patchPath) =>
        loadOverlayPatches(binName, patchPath),
      ),
    }
  })
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  return {
    name,
    dir,
    manifest,
    layers,
    patchPath,
    patches:
      options.userLayer !== false && existsSync(patchPath)
        ? loadOverlayPatches(binName, patchPath)
        : [],
  }
}

/** List the profile names initialized under the home. */
export function listProfiles(home: string = resolveDscHome()): string[] {
  const dir = profilesDir(home)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        existsSync(join(dir, entry.name, 'package.json')),
    )
    .map((entry) => entry.name)
    .sort()
}
