/**
 * The metacodes permission modes and their DeepSeek Harness projection.
 *
 * metacodes names a session's permission stance with one `--permission`
 * mode; the harness composes the same stance from a file-sandbox mode
 * (`dsh-sandbox-policy`) and an approval policy (`dsh-user-approval`, where
 * `ask` delegates to the composed answerers and fails closed without one,
 * and `never` auto-rejects every ask without prompting).
 * @module @dsc/core/permission
 */

/** metacodes permission modes, accepted by `--permission` and `/permissions`. */
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

/** DeepSeek Harness approval policies. */
export type ApprovalPolicy = 'ask' | 'never'

/** The harness stance one metacodes mode projects to. */
export interface PermissionStance {
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
}

/** Whether a string names a permission mode. */
export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * Map one metacodes permission mode onto the harness sandbox and approval pair.
 *
 * - `default` and `acceptEdits`: workspace writes without asking, anything
 *   else asks (an interactive surface prompts; a one-shot run denies);
 * - `plan`: the file sandbox is read-only and anything else asks;
 * - `dontAsk`: workspace writes without asking, anything else is rejected
 *   without a prompt;
 * - `auto`: the same stance as `dontAsk` — the harness has no auto-approve
 *   short of lifting the sandbox;
 * - `bypassPermissions`: full access, nothing asks.
 */
export function resolvePermission(mode: PermissionMode): PermissionStance {
  switch (mode) {
    case 'plan':
      return { sandboxMode: 'read-only', approvalPolicy: 'ask' }
    case 'auto':
    case 'dontAsk':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
    case 'bypassPermissions':
      return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
    case 'default':
    case 'acceptEdits':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }
  }
}
