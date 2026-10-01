/**
 * The one-shot run's resolved options and the metacodes permission presets.
 * @module @dsc/bundle-headless/options
 */

import type {
  ApprovalPolicy,
  PermissionMode,
  PermissionPreset,
  SandboxMode,
} from '@dsc/core'

export { PERMISSION_MODES, resolvePermission } from '@dsc/core'
export type { ApprovalPolicy, PermissionMode, SandboxMode } from '@dsc/core'

/** The service the startup plugin publishes and the runner consumes. */
export interface HeadlessOptions {
  /** The prompt text, or `-` to read stdin. */
  readonly prompt: string
  /** Emit the terminal `{"type":"result",...}` NDJSON line. */
  readonly json: boolean
  /** Also stream per-event NDJSON lines live. */
  readonly streamJson: boolean
  /** Persisted session to resume; a fresh session when absent. */
  readonly sessionId: string | undefined
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly permission: PermissionMode
  readonly sandboxMode: SandboxMode
  readonly approvalPolicy: ApprovalPolicy
  readonly preset: PermissionPreset
  /** Print the assembled system prompt and exit instead of running. */
  readonly dumpPrompt: boolean
  /** List every provider route and the default selection, then exit (no network). */
  readonly checkProviders: boolean
}

/** Service name published by `@dsc/bundle-headless/startup`. */
export const HEADLESS_SERVICE = 'dscHeadless'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dscHeadless?: HeadlessOptions
  }
}
