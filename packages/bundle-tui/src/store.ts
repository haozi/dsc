/**
 * The terminal transcript: an append-only list of rendered entries plus the
 * session status, projected from harness events. The UI subscribes with
 * `useSyncExternalStore`; it never holds business state of its own.
 * @module @dsc/bundle-tui/store
 */

/** One transcript row without its sequence number. */
export type EntryBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      name: string
      input: string
      result?: ToolOutcome
    }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'command'; text: string }

/** One transcript row. */
export type Entry = EntryBody & { seq: number }

/** A finished tool call. */
export interface ToolOutcome {
  isError: boolean
  content: string
}

/** Token usage totals in metacodes field names. */
export interface UsageTotals {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** A pending approval question shown at the prompt. */
export interface PendingApproval {
  id: number
  toolName: string
  reason: string | undefined
  answer(allowed: boolean): void
}

/** The whole UI-visible state. */
export interface Snapshot {
  entries: readonly Entry[]
  busy: boolean
  model: string
  provider: string
  permission: string
  sessionId: string
  cwd: string
  usage: UsageTotals
  turns: number
  toolCalls: number
  approval: PendingApproval | undefined
}

const zeroUsage = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

/** Append-only transcript with React-compatible subscriptions. */
export class TranscriptStore {
  readonly #listeners = new Set<() => void>()
  #snapshot: Snapshot
  #nextSeq = 1
  #liveAssistant: number | undefined
  #liveThinking: number | undefined
  #tools = new Map<string, number>()

  constructor(
    initial: Pick<
      Snapshot,
      'model' | 'provider' | 'permission' | 'sessionId' | 'cwd'
    >,
  ) {
    this.#snapshot = {
      entries: [],
      busy: false,
      usage: zeroUsage(),
      turns: 0,
      toolCalls: 0,
      approval: undefined,
      ...initial,
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): Snapshot => this.#snapshot

  #set(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) listener()
  }

  #append(entry: EntryBody): number {
    const seq = this.#nextSeq++
    this.#set({ entries: [...this.#snapshot.entries, { ...entry, seq }] })
    return seq
  }

  #replace(seq: number, update: (entry: Entry) => Entry): void {
    this.#set({
      entries: this.#snapshot.entries.map((entry) =>
        entry.seq === seq ? update(entry) : entry,
      ),
    })
  }

  /** The user submitted a prompt. */
  user(text: string): void {
    this.#append({ kind: 'user', text })
  }

  /** A slash command produced output. */
  command(text: string): void {
    this.#append({ kind: 'command', text })
  }

  notice(text: string): void {
    this.#append({ kind: 'notice', text })
  }

  error(text: string): void {
    this.#append({ kind: 'error', text })
  }

  /** Clear the visible transcript (counters and status stay). */
  clear(): void {
    this.#liveAssistant = undefined
    this.#liveThinking = undefined
    this.#tools.clear()
    this.#set({ entries: [] })
  }

  setBusy(busy: boolean): void {
    if (this.#snapshot.busy !== busy) this.#set({ busy })
  }

  setModel(provider: string, model: string): void {
    this.#set({ provider, model })
  }

  setPermission(permission: string): void {
    this.#set({ permission })
  }

  setApproval(approval: PendingApproval | undefined): void {
    this.#set({ approval })
  }

  /** A model request began (a metacodes "turn"). */
  turnBegin(): void {
    this.#liveAssistant = undefined
    this.#liveThinking = undefined
    this.#set({ turns: this.#snapshot.turns + 1 })
  }

  /** Append a live text delta to the streaming assistant row. */
  textDelta(text: string): void {
    if (text === '') return
    if (this.#liveAssistant === undefined) {
      this.#liveAssistant = this.#append({
        kind: 'assistant',
        text,
        streaming: true,
      })
      return
    }
    this.#replace(this.#liveAssistant, (entry) =>
      entry.kind === 'assistant'
        ? { ...entry, text: entry.text + text }
        : entry,
    )
  }

  thinkingDelta(text: string): void {
    if (text === '') return
    if (this.#liveThinking === undefined) {
      this.#liveThinking = this.#append({
        kind: 'thinking',
        text,
        streaming: true,
      })
      return
    }
    this.#replace(this.#liveThinking, (entry) =>
      entry.kind === 'thinking' ? { ...entry, text: entry.text + text } : entry,
    )
  }

  /** The step's assistant message committed: freeze the live rows to its text. */
  assistantCommitted(
    text: string,
    thinking: string,
    usage?: UsageTotals,
  ): void {
    if (this.#liveThinking !== undefined) {
      const seq = this.#liveThinking
      this.#liveThinking = undefined
      this.#replace(seq, (entry) =>
        entry.kind === 'thinking'
          ? {
              ...entry,
              text: thinking === '' ? entry.text : thinking,
              streaming: false,
            }
          : entry,
      )
    } else if (thinking !== '')
      this.#append({ kind: 'thinking', text: thinking, streaming: false })
    if (this.#liveAssistant !== undefined) {
      const seq = this.#liveAssistant
      this.#liveAssistant = undefined
      this.#replace(seq, (entry) =>
        entry.kind === 'assistant'
          ? {
              ...entry,
              text: text === '' ? entry.text : text,
              streaming: false,
            }
          : entry,
      )
    } else if (text !== '')
      this.#append({ kind: 'assistant', text, streaming: false })
    if (usage !== undefined) {
      const total = this.#snapshot.usage
      this.#set({
        usage: {
          input_tokens: total.input_tokens + usage.input_tokens,
          output_tokens: total.output_tokens + usage.output_tokens,
          cache_read_input_tokens:
            total.cache_read_input_tokens + usage.cache_read_input_tokens,
          cache_creation_input_tokens:
            total.cache_creation_input_tokens +
            usage.cache_creation_input_tokens,
        },
      })
    }
  }

  toolStart(id: string, name: string, input: string): void {
    this.#liveAssistant = undefined
    this.#liveThinking = undefined
    const seq = this.#append({ kind: 'tool', id, name, input })
    this.#tools.set(id, seq)
    this.#set({ toolCalls: this.#snapshot.toolCalls + 1 })
  }

  toolResult(id: string, result: ToolOutcome): void {
    const seq = this.#tools.get(id)
    if (seq === undefined) {
      this.#append({ kind: 'tool', id, name: '?', input: '', result })
      return
    }
    this.#tools.delete(id)
    this.#replace(seq, (entry) =>
      entry.kind === 'tool' ? { ...entry, result } : entry,
    )
  }

  /** The turn ended; a failure reason becomes an error row. */
  turnEnd(reason: {
    kind: string
    error?: { code: string; message: string }
  }): void {
    this.#liveAssistant = undefined
    this.#liveThinking = undefined
    if (reason.kind === 'error' && reason.error !== undefined)
      this.error(`${reason.error.code}: ${reason.error.message}`)
    else if (reason.kind === 'aborted') this.notice('interrupted')
    else if (reason.kind !== 'completed')
      this.notice(`turn ended: ${reason.kind}`)
  }
}
