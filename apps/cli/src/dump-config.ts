/**
 * `dsc --profile <name> --dump-config`: compose the profile's patch layers
 * through the include's patch algorithm without booting, with one source
 * layer per bundle, the profile's own patch file, the home layer, and each
 * `--patch` overlay.
 * @module @dsc/cli/dump-config
 */
import {
  loadOptionalPatches,
  loadOverlayPatches,
  PROFILE_ROOT_FILENAME,
  renderConfigDump,
  type DumpLayer,
} from '@dsc/core'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NAME } from './install.ts'
import { homePatchPath, prepareProfile } from './profile-boot.ts'

/**
 * Render a profile composition with comments naming each source layer.
 * @param profile - the profile name.
 * @param defaultOnly - omit the user layers and overlays (recovery diagnostic).
 * @param patches - `--patch` overlay paths, in argv order.
 */
export function renderProfileDump(
  profile: string,
  defaultOnly: boolean,
  patches: readonly string[],
): string {
  const loaded = prepareProfile(profile, !defaultOnly)
  const layers: DumpLayer[] = loaded.layers.map((layer) => ({
    label: layer.packageName,
    patches: layer.patches,
  }))
  if (!defaultOnly) {
    if (existsSync(loaded.patchPath))
      layers.push({ label: loaded.patchPath, patches: loaded.patches })
    const homeFile = homePatchPath()
    const homePatches = loadOptionalPatches(NAME, homeFile)
    if (homePatches !== undefined)
      layers.push({ label: homeFile, patches: homePatches })
    for (const file of patches) {
      const absolute = resolve(file)
      layers.push({
        label: absolute,
        patches: loadOverlayPatches(NAME, absolute),
      })
    }
  }
  return renderConfigDump(NAME, join(loaded.dir, PROFILE_ROOT_FILENAME), layers)
}

/** Print the dump to stdout. */
export function runDumpConfig(
  profile: string,
  defaultOnly: boolean,
  patches: readonly string[],
): void {
  process.stdout.write(renderProfileDump(profile, defaultOnly, patches))
}
