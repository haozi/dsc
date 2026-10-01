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
  /** The `dsh-permission-presets` preset carrying exactly this pair. */
  preset: PermissionPreset
}

/**
 * The preset table dsc bundles configure on the `permission` row: the three
 * DeepSeek Harness defaults plus `dont-ask`, which the harness base does not
 * ship and which `dontAsk`/`auto` need (workspace writes without prompts,
 * everything else rejected without asking).
 */
export const PERMISSION_PRESETS = {
  'read-only': {
    sandbox: 'read-only',
    approval: 'ask',
    name: 'read-only',
    description: 'Read-only file access; anything else asks.',
  },
  'workspace-write': {
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'workspace-write',
    description: 'Writes inside the workspace; anything else asks.',
  },
  'dont-ask': {
    sandbox: 'workspace-write',
    approval: 'never',
    name: 'dont-ask',
    description:
      'Writes inside the workspace; anything else is rejected without asking.',
  },
  'danger-full-access': {
    sandbox: 'danger-full-access',
    approval: 'never',
    name: 'danger-full-access',
    description: 'Full file access without approval prompts.',
  },
} as const satisfies Record<
  string,
  {
    sandbox: SandboxMode
    approval: ApprovalPolicy
    name: string
    description: string
  }
>

export type PermissionPreset = keyof typeof PERMISSION_PRESETS

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
  const preset = presetOf(mode)
  const spec = PERMISSION_PRESETS[preset]
  return { sandboxMode: spec.sandbox, approvalPolicy: spec.approval, preset }
}

/** The preset name one metacodes mode selects. */
export function presetOf(mode: PermissionMode): PermissionPreset {
  switch (mode) {
    case 'plan':
      return 'read-only'
    case 'auto':
    case 'dontAsk':
      return 'dont-ask'
    case 'bypassPermissions':
      return 'danger-full-access'
    case 'default':
    case 'acceptEdits':
      return 'workspace-write'
  }
}
