/**
 * The one-shot run's resolved options and the metacodes permission presets.
 * @module @dsc/bundle-headless/options
 */

/** metacodes permission modes, accepted by `--permission`. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** DeepSeek Harness file-sandbox modes. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** DeepSeek Harness approval policies; `ask` fails closed without an answerer. */
export type ApprovalPolicy = 'ask' | 'never'

/**
 * Map one metacodes permission mode onto the dsh sandbox and approval pair.
 * In a one-shot run no answerer exists, so `ask` denies instead of prompting:
 * `default`, `acceptEdits` and `dontAsk` all deny what would need a prompt,
 * `plan` additionally pins the file sandbox read-only, and `auto` /
 * `bypassPermissions` approve without asking.
 */
export function resolvePermission(mode: PermissionMode): {
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
} {
  switch (mode) {
    case 'plan':
      return { sandboxMode: 'read-only', approvalPolicy: 'ask' }
    case 'auto':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
    case 'bypassPermissions':
      return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
    case 'default':
    case 'acceptEdits':
    case 'dontAsk':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }
  }
}

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
  /** Print the assembled system prompt and exit instead of running. */
  readonly dumpPrompt: boolean
}

/** Service name published by `@dsc/bundle-headless/startup`. */
export const HEADLESS_SERVICE = 'dscHeadless'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dscHeadless?: HeadlessOptions
  }
}
