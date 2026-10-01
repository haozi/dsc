/**
 * Facts about the launched profile, provided to the tree as `dscProfile`.
 * Plugins read it for the profile's directory, user layer, and bundle list;
 * scheduling and mutation belong to their callers.
 * @module @dsc/core/profile-context
 */
import type { PatchOptions } from './patches.ts'

/** Current profile facts. */
export interface DscProfileContext {
  readonly name: string
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, in layer order. */
  readonly bundles: readonly string[]
  /** Parsed `--patch` overlays, applied above the profile and home layers. */
  readonly overlays: readonly PatchOptions[]
}

/** Context slot the launcher fills before any entry mounts. */
export const DSC_PROFILE_KEY = 'dscProfile'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsc. */
    dscProfile?: DscProfileContext
  }
}
