/**
 * `dsc --profile <name> --dump-plugins`: the plugin inventory of a composed
 * profile as one JSON document, without booting or evaluating `!!js`. Every
 * row names the package it resolves to (installation first, then the
 * profile directory), its version, and the layer that inserted it, so an
 * operator can see exactly which code a profile would load.
 * @module @dsc/cli/dump-plugins
 */
import { isJsExpr } from '@deepseek-ai/cordis-plugin-loader'
import {
  composeEntries,
  packageDirFromAnchor,
  readManifest,
  type EntryOptions,
  type PatchOptions,
} from '@dsc/core'
import { join, resolve } from 'node:path'
import { INSTALL_ANCHOR, NAME } from './install.ts'
import { composeProfile } from './profile-boot.ts'

/** One resolved package. */
export interface ResolvedPackage {
  package: string
  version: string | null
  dir: string
  /** Where the package resolved from. */
  source: 'installation' | 'profile'
}

/** One inventory row. */
export interface PluginRow {
  id: string
  name: string
  /** `true`, `false`, or the unevaluated `!!js` expression. */
  disabled: boolean | { expr: string }
  /** The row's parent group id, or null at the root. */
  group: string | null
  /** The layer label that inserted the row. */
  inserted_by: string
  resolved: ResolvedPackage | null
}

/** The whole inventory. */
export interface PluginInventory {
  profile: string
  dir: string
  layers: {
    package: string
    version: string | null
    dir: string
    patch_files: string[]
  }[]
  entries: PluginRow[]
}

/** The package name a bare specifier names (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageNameOf(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('cordis:')
  )
    return undefined
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function resolvePackage(
  specifier: string,
  profileDir: string,
): ResolvedPackage | null {
  const name = packageNameOf(specifier)
  if (name === undefined) return null
  for (const [anchor, source] of [
    [INSTALL_ANCHOR, 'installation'],
    [join(profileDir, 'package.json'), 'profile'],
  ] as const) {
    const dir = packageDirFromAnchor(anchor, name)
    if (dir === undefined) continue
    return {
      package: name,
      version: readManifest(NAME, join(dir, 'package.json')).version ?? null,
      dir,
      source,
    }
  }
  return null
}

/** Which labelled layer first inserted each row id. */
function insertionIndex(
  layers: readonly { label: string; patches: readonly PatchOptions[] }[],
): Map<string, string> {
  const origin = new Map<string, string>()
  const walk = (rows: readonly EntryOptions[], label: string): void => {
    for (const row of rows) {
      if (typeof row.id === 'string' && !origin.has(row.id))
        origin.set(row.id, label)
      if (row.group && Array.isArray(row.config))
        walk(row.config as EntryOptions[], label)
    }
  }
  for (const layer of layers)
    for (const patch of layer.patches)
      if (patch.insert !== undefined) walk(patch.insert, layer.label)
  return origin
}

/** Build the inventory for `profile`. */
export function pluginInventory(
  profile: string,
  patchFiles: readonly string[],
): PluginInventory {
  const composed = composeProfile(profile, patchFiles)
  const labelled = [
    ...composed.profile.layers.map((layer) => ({
      label: layer.packageName,
      patches: layer.patches,
    })),
    { label: composed.profile.patchPath, patches: composed.profile.patches },
    { label: 'home', patches: composed.homePatches },
    ...patchFiles.map((file, index) => ({
      label: resolve(file),
      patches: composed.overlays.slice(index, index + 1).flat(),
    })),
    { label: 'launcher', patches: composed.overlays.slice(patchFiles.length) },
  ]
  const origin = insertionIndex(labelled)
  const entries: PluginRow[] = []
  const walk = (rows: readonly EntryOptions[], group: string | null): void => {
    for (const row of rows) {
      const disabled = isJsExpr(row.disabled)
        ? { expr: (row.disabled as { __jsExpr: string }).__jsExpr }
        : row.disabled === true
      entries.push({
        id: row.id,
        name: row.name,
        disabled,
        group,
        inserted_by: origin.get(row.id) ?? 'unknown',
        resolved: resolvePackage(row.name, composed.profile.dir),
      })
      if (row.group && Array.isArray(row.config))
        walk(row.config as EntryOptions[], row.id)
    }
  }
  walk(
    composeEntries([
      composed.bundlePatches,
      composed.profile.patches,
      composed.homePatches,
      composed.overlays,
    ]),
    null,
  )
  return {
    profile,
    dir: composed.profile.dir,
    layers: composed.profile.layers.map((layer) => ({
      package: layer.packageName,
      version: layer.version ?? null,
      dir: layer.packageDir,
      patch_files: layer.patchPaths,
    })),
    entries,
  }
}

/** Print the inventory to stdout. */
export function runDumpPlugins(
  profile: string,
  patchFiles: readonly string[],
): void {
  process.stdout.write(
    JSON.stringify(pluginInventory(profile, patchFiles), undefined, 2) + '\n',
  )
}
