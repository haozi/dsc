/** @jsxRuntime automatic @jsxImportSource react */
/**
 * @dsc/bundle-tui — the interactive terminal over the DeepSeek Harness base.
 * The plugin creates one Agent through the core registry (or resumes the
 * Session `--resume` names), answers approval questions at the prompt,
 * projects the session into the transcript store, and renders the React +
 * Ink REPL. Prompts become follow-up turns; slash verbs and `!cmd` never
 * reach the model.
 * @module @dsc/bundle-tui
 */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolvePermission, type PermissionMode } from '@dsc/core'
import { render } from 'ink'
import { randomUUID } from 'node:crypto'
import { App } from './app.tsx'
import {
  dispatchLine,
  type CommandContext,
  type ModelSelectionRef,
} from './commands.ts'
import { attachProjection } from './projection.ts'
import { TUI_SERVICE, type TuiOptions } from './startup.ts'
import { TranscriptStore, type PendingApproval } from './store.ts'

/** Stable cordis plugin name. */
export const name = 'dsc-tui'

/** Services required before the terminal can start. */
export const inject = [TUI_SERVICE, 'agentDefaultModel', 'agents', 'sessions']

/** The harness agent slice the terminal drives. */
interface Agent {
  readonly ctx: Context
  readonly session: { readonly id: string; seq: number }
  readonly status: 'idle' | 'running'
  whenIdle(): Promise<void>
  followup(message: unknown): void
  cancel(cause: { kind: 'user' }): void
}

interface Agents {
  create(options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: Context) => void
  }): Promise<{ agent: Agent }>
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: Context) => void
  }): Promise<{ agent: Agent }>
}

interface ApprovalRequest {
  agent: unknown
  toolName: string
  reason?: string
  displayReason?: { en: string }
  signal?: AbortSignal
}

async function resolveCwd(ctx: Context): Promise<string> {
  const fs = ctx.get('fs') as
    | {
        resolve(path: string): Promise<unknown>
        processPath(resolved: unknown): string
      }
    | undefined
  if (fs === undefined) return process.cwd()
  return fs.processPath(await fs.resolve('.'))
}

/** Answer approval questions for `agent` through the transcript store. */
function answerApprovals(
  ctx: Context,
  agent: Agent,
  store: TranscriptStore,
): () => void {
  let nextId = 1
  return ctx.on(
    'approval/request' as never,
    (async (request: ApprovalRequest, next: () => Promise<string>) => {
      if (request.agent !== agent) return next()
      if (store.getSnapshot().approval !== undefined) return 'rejected'
      return new Promise<string>((resolve) => {
        const settle = (outcome: string): void => {
          request.signal?.removeEventListener('abort', onAbort)
          store.setApproval(undefined)
          resolve(outcome)
        }
        const onAbort = (): void => settle('cancelled')
        request.signal?.addEventListener('abort', onAbort, { once: true })
        const pending: PendingApproval = {
          id: nextId++,
          toolName: request.toolName,
          reason: request.displayReason?.en ?? request.reason,
          answer: (allowed) => settle(allowed ? 'allowed-once' : 'rejected'),
        }
        store.setApproval(pending)
      })
    }) as never,
  )
}

/**
 * Mount the terminal.
 * @param ctx - plugin context carrying the harness services and the launcher's exit request.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined)
    throw new Error(
      `${name}: the launcher must provide ctx.appExit before the tree mounts`,
    )
  const options = ctx.get(TUI_SERVICE) as TuiOptions | undefined
  if (options === undefined)
    throw new Error(`${name}: the ${TUI_SERVICE} service is required`)
  start(ctx, options, exit).catch((error: unknown) => {
    process.stderr.write(
      `dsc: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    exit(1)
  })
}

async function start(
  ctx: Context,
  options: TuiOptions,
  exit: (code: number) => void,
): Promise<void> {
  await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
  const agents = ctx.get('agents') as Agents | undefined
  const defaultModel = ctx.get('agentDefaultModel') as
    | {
        currentSelection(): {
          provider: string
          model: string
          reasoningEffort?: string
        }
      }
    | undefined
  const sessions = ctx.get('sessions') as
    { flush(session: unknown): Promise<void> } | undefined
  if (
    agents === undefined ||
    defaultModel === undefined ||
    sessions === undefined
  )
    return

  const base = defaultModel.currentSelection()
  const selection: ModelSelectionRef = {
    current: {
      provider: options.provider ?? base.provider,
      model: options.model ?? base.model,
      ...(options.provider === undefined &&
      options.model === undefined &&
      base.reasoningEffort !== undefined
        ? { reasoningEffort: base.reasoningEffort }
        : {}),
    },
    assembled: undefined,
  }
  const agentOptions = {
    provider: selection.current!.provider,
    model: selection.current!.model,
  }
  const setup = (agentCtx: Context): void => {
    installModelSelection(agentCtx, selection as never)
  }
  const cwd = await resolveCwd(ctx)
  const agent =
    options.resume === undefined
      ? (
          await agents.create({
            sessionId: `session-${randomUUID()}`,
            meta: { cwd },
            agentOptions,
            setup,
          })
        ).agent
      : (
          await agents.resume({
            resumeSessionId: options.resume,
            agentOptions,
            setup,
          })
        ).agent
  await agent.whenIdle()

  const store = new TranscriptStore({
    model: selection.current!.model,
    provider: selection.current!.provider,
    permission: options.permission,
    sessionId: agent.session.id,
    cwd,
  })
  if (options.resume !== undefined) store.notice(`resumed ${agent.session.id}`)

  const approval = ctx.get('approval') as
    { setPolicy(agent: unknown, policy: 'ask' | 'never'): void } | undefined
  const presets = ctx.get('permissionPresets') as
    | {
        apply(
          session: unknown,
          name: string,
          setPolicy: (policy: 'ask' | 'never') => void,
        ): void
      }
    | undefined
  const command: CommandContext = {
    ctx,
    agent,
    store,
    selection,
    cwd,
    setPermission(mode: PermissionMode) {
      const stance = resolvePermission(mode)
      if (presets === undefined)
        throw new Error(
          'the permissionPresets service is not mounted; dsh-base provides it',
        )
      presets.apply(agent.session, stance.preset, (policy) =>
        approval?.setPolicy(agent, policy),
      )
    },
    exit: () => void finish(0),
  }

  const detachProjection = attachProjection(ctx, agent, store)
  const detachApprovals = answerApprovals(ctx, agent, store)
  let finished = false
  let instance: ReturnType<typeof render> | undefined
  const finish = async (code: number): Promise<void> => {
    if (finished) return
    finished = true
    detachApprovals()
    detachProjection()
    instance?.unmount()
    if (agent.status === 'running') agent.cancel({ kind: 'user' })
    try {
      await agent.whenIdle()
      await sessions.flush(agent.session)
    } catch {
      // the session may already be gone; exiting is still the right outcome
    }
    exit(code)
  }

  instance = render(
    <App
      host={{
        store,
        theme: options.theme,
        interrupt: () => agent.cancel({ kind: 'user' }),
        submit: async (line) => {
          const outcome = await dispatchLine(line, command)
          if (outcome === 'exit') return
          if (outcome !== 'prompt') return
          store.user(line.trim())
          store.setBusy(true)
          agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: line.trim() }],
              source: { kind: 'user' },
            }),
          )
        },
      }}
    />,
    { exitOnCtrlC: true },
  )
  await instance.waitUntilExit()
  await finish(0)
}
