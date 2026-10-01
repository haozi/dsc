/**
 * @dsc/bundle-headless — the metacodes-style one-shot driver over the
 * DeepSeek Harness base. It creates one Agent through the core registry (or
 * resumes the Session `--session` names), drives the prompt to quiescence,
 * flushes the Session, prints the result, and exits:
 *
 * - plain mode prints the final assistant text to stdout and streams
 *   provider reasoning to stderr;
 * - `--stream-json` streams metacodes NDJSON lines live;
 * - `--json` ends with one `{"type":"result",...}` line;
 * - `--dump-prompt` prints the assembled system prompt and exits.
 *
 * @module @dsc/bundle-headless
 */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import {
  RunProjection,
  jsonLine,
  renderResult,
  type HarnessChunk,
  type HarnessEvent,
} from './ndjson.ts'
import { HEADLESS_SERVICE, type HeadlessOptions } from './options.ts'

/** Stable cordis plugin name. */
export const name = 'dsc-headless-runner'

/** Services required before the one-shot run can start. */
export const inject = [
  HEADLESS_SERVICE,
  'agentDefaultModel',
  'agents',
  'sessions',
]

/** Process-facing effects; tests substitute captures. */
export interface RunnerIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  readStdin(): Promise<string>
  exit(code: number): void
}

/** The process streams the runner uses by default. */
export const internals: Omit<RunnerIo, 'exit'> = {
  stdout: process.stdout,
  stderr: process.stderr,
  readStdin: async () => {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  },
}

/** Only the loosely-typed slices of the harness services the runner touches. */
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

interface Agent {
  readonly ctx: Context
  readonly session: {
    seq: number
    eventAt(seq: number): HarnessEvent | undefined
  }
  whenIdle(): Promise<void>
  followup(message: unknown): void
}

interface DefaultModel {
  currentSelection(): {
    provider: string
    model: string
    reasoningEffort?: string
  }
}

interface Sessions {
  flush(session: Agent['session']): Promise<void>
}

/** Stream provider reasoning to stderr while the run is live (plain mode). */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: RunnerIo['stderr'],
): () => void {
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on(
    'agent/assistant-stream' as never,
    ((payload: {
      agent: unknown
      frame: { type: string; chunk?: HarnessChunk }
    }) => {
      if (payload.agent !== agent) return
      if (payload.frame.type !== 'chunk' || payload.frame.chunk === undefined) {
        close()
        return
      }
      const chunk = payload.frame.chunk
      if (chunk.type === 'reasoning-delta') {
        const text = (chunk as { text: string }).text
        if (text === '') return
        if (!open) {
          stderr.write('dsc: reasoning:\n')
          open = true
        }
        stderr.write(text)
        endsWithNewline = text.endsWith('\n')
        return
      }
      if (chunk.type === 'text-delta' || chunk.type === 'finish') close()
    }) as never,
  )
  return () => {
    dispose()
    close()
  }
}

/** Subscribe the projection to the agent's durable events and live chunks. */
function attachProjection(
  ctx: Context,
  agent: Agent,
  projection: RunProjection,
): () => void {
  const offEvents = ctx.on(
    'session/event' as never,
    ((session: unknown, event: HarnessEvent) => {
      if (session !== agent.session) return
      projection.event(event)
    }) as never,
  )
  const offChunks = ctx.on(
    'agent/assistant-stream' as never,
    ((payload: {
      agent: unknown
      frame: { type: string; chunk?: HarnessChunk }
    }) => {
      if (payload.agent !== agent) return
      if (payload.frame.type === 'chunk' && payload.frame.chunk !== undefined)
        projection.chunk(payload.frame.chunk)
    }) as never,
  )
  return () => {
    offEvents()
    offChunks()
  }
}

/** Report a driver failure and request a failing exit. */
function fail(io: RunnerIo, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error)
  if (json) io.stdout.write(`${jsonLine({ type: 'error', message })}\n`)
  io.stderr.write(`dsc: ${message}\n`)
  io.exit(1)
}

/** Resolve the working directory the mounted filesystem reports. */
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

/** Provider routes and the default selection, as `--check-providers` prints them. */
export interface ProviderReport {
  default: { provider: string; model: string; reasoningEffort?: string }
  providers: { id: string; name: string; selected: boolean }[]
  /** Whether the default provider has a registered adapter. */
  default_routed: boolean
}

/** Build the report from the mounted llm registry. */
export function providerReport(
  ctx: Context,
  defaultModel: DefaultModel,
): ProviderReport {
  const llm = ctx.get('llm') as
    { listProviders(): { id: string; name: string }[] } | undefined
  if (llm === undefined)
    throw new Error(
      '--check-providers requires the llm service; dsh-base provides it',
    )
  const selection = defaultModel.currentSelection()
  const providers = llm
    .listProviders()
    .map((provider) => ({
      ...provider,
      selected: provider.id === selection.provider,
    }))
  return {
    default: selection,
    providers,
    default_routed: providers.some((provider) => provider.selected),
  }
}

/** Render the report as text. */
export function renderProviderReport(report: ProviderReport): string {
  const lines = [
    `default: ${report.default.provider} / ${report.default.model}${report.default.reasoningEffort === undefined ? '' : ` (effort ${report.default.reasoningEffort})`}${report.default_routed ? '' : '  [no adapter registered for this provider]'}`,
    'providers:',
    ...report.providers.map(
      (provider) =>
        `  ${provider.selected ? '*' : ' '} ${provider.id.padEnd(24)} ${provider.name}`,
    ),
  ]
  if (report.providers.length === 0) lines.push('  (none registered)')
  return lines.join('\n') + '\n'
}

/** Print the assembled system prompt for the agent's scope and exit. */
async function dumpPrompt(
  ctx: Context,
  agent: Agent,
  io: RunnerIo,
): Promise<void> {
  const systemPrompt = ctx.get('systemPrompt') as
    { assemble(context?: { scope?: object }): Promise<unknown> } | undefined
  if (systemPrompt === undefined)
    throw new Error(
      '--dump-prompt requires the systemPrompt service; dsh-base provides it',
    )
  const { renderPrompt } = (await import('@deepseek-ai/dsh-system-prompt')) as {
    renderPrompt(assembly: unknown): string
  }
  const assembly = await systemPrompt.assemble({ scope: agent })
  io.stdout.write(renderPrompt(assembly) + '\n')
  io.exit(0)
}

/**
 * Run one prompt through one Agent and request process exit.
 * @param ctx - plugin context carrying the harness services.
 * @param options - the parsed command line.
 * @param io - process-facing effects.
 */
export async function run(
  ctx: Context,
  options: HeadlessOptions,
  io: RunnerIo,
): Promise<void> {
  await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
  const agents = ctx.get('agents') as Agents | undefined
  const defaultModel = ctx.get('agentDefaultModel') as DefaultModel | undefined
  const sessions = ctx.get('sessions') as Sessions | undefined
  if (
    agents === undefined ||
    defaultModel === undefined ||
    sessions === undefined
  )
    return

  if (options.checkProviders) {
    const report = providerReport(ctx, defaultModel)
    io.stdout.write(
      options.json
        ? JSON.stringify(report) + '\n'
        : renderProviderReport(report),
    )
    io.exit(report.default_routed ? 0 : 1)
    return
  }
  const prompt = options.prompt === '-' ? await io.readStdin() : options.prompt
  if (prompt.trim() === '' && !options.dumpPrompt)
    throw new Error('a prompt is required, for example: dsc -p "run the tests"')

  const base = defaultModel.currentSelection()
  const selection = {
    provider: options.provider ?? base.provider,
    model: options.model ?? base.model,
    ...(options.provider === undefined &&
    options.model === undefined &&
    base.reasoningEffort !== undefined
      ? { reasoningEffort: base.reasoningEffort }
      : {}),
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx: Context): void => {
    installModelSelection(agentCtx, {
      current: selection as never,
      assembled: undefined,
    })
  }
  const cwd = await resolveCwd(ctx)
  let agent: Agent
  if (options.sessionId === undefined) {
    agent = (
      await agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd },
        agentOptions,
        setup,
      })
    ).agent
  } else {
    if (ctx.get('sessionPersistence') === undefined)
      throw new Error(
        '--session requires the sessionPersistence service; dsh-base provides it',
      )
    try {
      agent = (
        await agents.resume({
          resumeSessionId: options.sessionId,
          agentOptions,
          setup,
        })
      ).agent
    } catch (error) {
      const code = (error as { code?: string }).code
      if (
        code === 'SESSION_QUERY_SESSION_NOT_FOUND' ||
        code === 'SESSION_NOT_FOUND'
      )
        throw new Error(
          `session "${options.sessionId}" does not exist; omit --session to start a new one`,
        )
      throw error
    }
  }
  await agent.whenIdle()
  if (options.dumpPrompt) {
    await dumpPrompt(ctx, agent, io)
    return
  }

  const stream = options.streamJson
    ? { write: (line: string) => io.stdout.write(`${line}\n`) }
    : undefined
  const projection = new RunProjection(stream)
  const detach = attachProjection(ctx, agent, projection)
  const stopReasoning =
    options.streamJson || options.json
      ? undefined
      : streamReasoning(ctx, agent, io.stderr)
  try {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
  } finally {
    stopReasoning?.()
    detach()
  }
  await sessions.flush(agent.session)
  const result = projection.result()
  if (options.json) io.stdout.write(`${renderResult(result)}\n`)
  else if (!options.streamJson) io.stdout.write(result.text + '\n')
  const reason = projection.reason
  if (reason?.kind === 'error' && reason.error !== undefined)
    io.stderr.write(`dsc: ${reason.error.code}: ${reason.error.message}\n`)
  io.exit(reason?.kind === 'completed' ? 0 : 1)
}

/** Replay the durable log of a session into a projection (used for a resumed session's summary). */
export function replay(
  session: Agent['session'],
  projection: RunProjection,
  fromSeq: number,
): void {
  for (let seq = fromSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq) as unknown as number)
    if (event !== undefined) projection.event(event)
  }
}

/**
 * Mount the one-shot driver.
 * @param ctx - plugin context carrying the options service and the launcher's exit request.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined)
    throw new Error(
      `${name}: the launcher must provide ctx.appExit before the tree mounts`,
    )
  const options = ctx.get(HEADLESS_SERVICE) as HeadlessOptions | undefined
  if (options === undefined)
    throw new Error(`${name}: the ${HEADLESS_SERVICE} service is required`)
  const io: RunnerIo = { ...internals, exit }
  run(ctx, options, io).catch((error: unknown) => {
    fail(io, error, options.json || options.streamJson)
  })
}
