/**
 * Shared profile boot for every `dsc` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsc.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, the home-level `$DSC_HOME/cordis.patch.yml`,
 * `--patch` overlays, the telemetry switch), mount the tree over the
 * profile's empty root, keep both user layers live, and wire fail-loud plus
 * bounded shutdown.
 *
 * App flags are not the launcher's business: the inner arguments reach the
 * tree through `ctx.cmdlineArgs`, where any app plugin reads the same
 * immutable snapshot.
 * @module @dsc/cli/profile-boot
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  composeEntries,
  createAppReady,
  createProcessShutdown,
  DSC_PROFILE_KEY,
  healProfilesModuleFallback,
  HOME_PATCH_FILENAME,
  indexRows,
  installFailLoud,
  LAUNCH_ENVIRONMENT_KEY,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_ROOT_CONFIG,
  PROFILE_ROOT_FILENAME,
  provideCmdline,
  resolveDscHome,
  watchPatchFile,
  type DscProfileContext,
  type EntryOptions,
  type LaunchEnvironment,
  type PatchOptions,
  type ProcessShutdown,
  type Profile,
} from '@dsc/core'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { INSTALL_ANCHOR, NAME, PROFILE_TEMPLATES } from './install.ts'

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
export const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The home-level user patch layer, applied over every profile's own layer. */
export function homePatchPath(): string {
  return join(resolveDscHome(), HOME_PATCH_FILENAME)
}

/**
 * Resolve the telemetry opt-out into its boot patch. ANY non-empty value
 * (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. Without the row nothing is generated.
 */
export function resolveTelemetryPatch(
  disabledEnv: string | undefined,
  hasRow: boolean,
): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a profile: heal the module fallback, then (re)write the empty root.
 * The root is always rewritten because the whole composition is patch
 * layers; the Loader's tree write-back could otherwise bake composed rows
 * into the file and duplicate every bundle insert on the next boot.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, {
    userLayer,
    templates: PROFILE_TEMPLATES,
  })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** A composed profile: its layers in application order and the row index. */
export interface ComposedProfile {
  profile: Profile
  bundlePatches: PatchOptions[]
  homePatches: PatchOptions[]
  overlays: PatchOptions[]
  rows: Map<string, EntryOptions>
}

/** The full patch stack of one composed profile, in application order. */
export function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,
    ...composed.profile.patches,
    ...composed.homePatches,
    ...composed.overlays,
  ]
}

/**
 * Compose a profile's effective patch stack: bundle layers, the profile's
 * user layer, the home-level layer, `--patch` overlays, then the telemetry
 * switch.
 */
export function composeProfile(
  name: string,
  patchFiles: readonly string[],
): ComposedProfile {
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap((file) =>
    loadOverlayPatches(NAME, resolve(file)),
  )
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
  const rows = indexRows(
    composeEntries([bundlePatches, profile.patches, homePatches, overlays]),
  )
  const composedOverlays = [...overlays]
  const telemetryPatch = resolveTelemetryPatch(
    process.env.DSH_TELEMETRY_DISABLED,
    rows.has(TELEMETRY_ROW_ID),
  )
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return {
    profile,
    bundlePatches,
    homePatches,
    overlays: composedOverlays,
    rows,
  }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  environment: LaunchEnvironment
  profile: string
  patchFiles: readonly string[]
  args: readonly string[]
  /** Extra host setup before the tree mounts (tests inject probes). */
  prepare?: (ctx: Context) => void | Promise<void>
}

/**
 * Boot one profile end to end and leave process lifetime to the mounted
 * plugins (or to a one-shot runner the composition mounts).
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(
  options: RunProfileOptions,
): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = composeProfile(options.profile, options.patchFiles)
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => {
    await app.current?.fiber.dispose()
  })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  process.on('SIGTERM', () => interrupt(0))
  process.on('SIGINT', () => interrupt(130))
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })
  const appReady = createAppReady()
  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  const profileContext: DscProfileContext = {
    name: options.profile,
    dir: composed.profile.dir,
    patchPath: composed.profile.patchPath,
    installAnchor: INSTALL_ANCHOR,
    cwd: process.cwd(),
    home: resolveDscHome(),
    bundles: composed.profile.layers.map((layer) => layer.packageName),
    overlays: composed.overlays,
  }
  const composeLive = (): PatchOptions[] => [
    ...composed.bundlePatches,
    ...(loadOptionalPatches(NAME, composed.profile.patchPath) ?? []),
    ...(loadOptionalPatches(NAME, homePatchPath()) ?? []),
    ...composed.overlays,
  ]
  const ctx = await boot(
    NAME,
    rootConfig,
    allPatches(composed),
    async (hostCtx) => {
      app.current = hostCtx
      hostCtx.provide(DSC_PROFILE_KEY, profileContext)
      hostCtx.provide(LAUNCH_ENVIRONMENT_KEY, options.environment)
      provideCmdline(hostCtx, {
        args: options.args,
        exit: (code) => void shutdown.shutdown(code),
        ready: appReady.service,
      })
      await options.prepare?.(hostCtx)
    },
  )
  app.current = ctx
  if (
    !signalShutdown.signal.aborted &&
    ctx.fiber.state === 2 &&
    ctx.get('loader') !== undefined
  ) {
    for (const filename of [composed.profile.patchPath, homePatchPath()]) {
      try {
        const stop = watchPatchFile(ctx, {
          binName: NAME,
          filename,
          compose: composeLive,
        })
        ctx.fiber.effect(() => stop)
      } catch (error) {
        if (!signalShutdown.signal.aborted) throw error
      }
    }
    appReady.commit()
  }
  return { ctx, shutdown }
}
