/**
 * The metacodes NDJSON dialect for headless runs.
 *
 * `--stream-json` emits one JSON object per line as the run progresses;
 * `--json` emits the terminal `{"type":"result",...}` line. Both share one
 * `type` namespace, so a consumer that filters on `type === "result"` is
 * forward compatible with the live lines. Every line is valid UTF-8: text
 * deltas cut inside a multi-byte character are held back and rejoined with
 * the next delta of the same kind, and a character the block ends without
 * completing is emitted as one U+FFFD rather than dropped. Previews are cut
 * at code-point boundaries and carry `"truncated":true` explicitly.
 *
 * metacodes counts one model request as a "turn"; the DeepSeek Harness calls
 * that a "step" inside a user-level turn. This projection reports harness
 * steps as metacodes turns.
 * @module @dsc/bundle-headless/ndjson
 */

/** Per-field preview cap in bytes (tool input and result previews). */
export const MAX_FIELD_PREVIEW = 2048

/** Where lines go; one `write` per complete line. */
export interface LineSink {
  write(line: string): void
}

/** Token usage in metacodes field names. */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The shape of a harness token usage report. */
export interface HarnessUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
}

export function toUsage(usage: HarnessUsage): Usage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
  }
}

export function addUsage(total: Usage, next: Usage): Usage {
  return {
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    cache_read_input_tokens:
      total.cache_read_input_tokens + next.cache_read_input_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + next.cache_creation_input_tokens,
  }
}

/**
 * Truncate a string to `maxBytes` of UTF-8 at a code-point boundary.
 * @returns the (possibly shortened) text and whether it was cut.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  // Step back over UTF-8 continuation bytes (10xxxxxx) to a boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

/** Build a preview field pair: `{<key>: text, truncated?: true}`. */
function preview(key: string, text: string): Record<string, unknown> {
  const cut = truncateUtf8(text, MAX_FIELD_PREVIEW)
  return cut.truncated
    ? { [key]: cut.text, truncated: true }
    : { [key]: cut.text }
}

/** Replace lone surrogates so `JSON.stringify` output is valid UTF-8. */
export function sanitize(text: string): string {
  return text.toWellFormed()
}

/** Serialize one line with sanitized strings. */
export function jsonLine(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string' ? sanitize(item) : (item as unknown),
  )
}

/**
 * Rejoin text deltas that a provider split inside a multi-byte character.
 * Deltas arrive as JavaScript strings, so a split shows up as a lone
 * surrogate half at the end of one delta and the start of the next.
 */
export class DeltaJoiner {
  #tail = ''

  /** Consume a delta; returns the text safe to emit now (possibly empty). */
  push(delta: string): string {
    const joined = this.#tail + delta
    this.#tail = ''
    if (joined === '') return ''
    const last = joined.charCodeAt(joined.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      this.#tail = joined.slice(-1)
      return joined.slice(0, -1)
    }
    return joined
  }

  /** Close the block: a held half becomes one U+FFFD. */
  flush(): string {
    const tail = this.#tail
    this.#tail = ''
    return tail === '' ? '' : '\uFFFD'
  }
}

/** The live event kinds `--stream-json` emits. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: string }
  | { type: 'tool_result'; id: string; is_error: boolean; content: string }
  | ({ type: 'usage' } & Usage)
  | { type: 'turn_begin'; turn: number }
  | { type: 'turn_end'; turn: number; tool_calls: number }
  | { type: 'run_end'; turns: number; tool_calls: number; stop_reason: string }
  | { type: 'error'; message: string }

/** Render one live event as its NDJSON line (without newline). */
export function renderStreamEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'tool_start':
      return jsonLine({
        type: 'tool_start',
        id: event.id,
        name: event.name,
        ...preview('input', event.input),
      })
    case 'tool_result':
      return jsonLine({
        type: 'tool_result',
        id: event.id,
        is_error: event.is_error,
        ...preview('content', event.content),
      })
    default:
      return jsonLine({ ...event })
  }
}

/** The terminal `result` line. */
export interface RunResult {
  stop_reason: string
  turns: number
  tool_calls: number
  usage: Usage
  cost_usd: number
  text: string
}

export function renderResult(result: RunResult): string {
  return jsonLine({
    type: 'result',
    stop_reason: result.stop_reason,
    turns: result.turns,
    tool_calls: result.tool_calls,
    ...result.usage,
    cost_usd: Number(result.cost_usd.toFixed(6)),
    text: result.text,
  })
}

/** The harness session events the projection consumes. */
export type HarnessEvent =
  | { type: 'step/start'; data: { turn: number; step: number } }
  | { type: 'step/end'; data: { turn: number; step: number } }
  | { type: 'turn/start'; data: { turn: number } }
  | {
      type: 'turn/end'
      data: {
        turn: number
        reason: { kind: string; error?: { code: string; message: string } }
      }
    }
  | {
      type: 'assistant/message'
      data: {
        message: { content: readonly { type: string; text?: string }[] }
        usage?: HarnessUsage
      }
    }
  | {
      type: 'tool/call'
      data: { callId: string; name: string; arguments: string }
    }
  | {
      type: 'tool/result'
      surfaceOp?: unknown
      data: {
        message: {
          toolCallId: string
          isError?: boolean
          content: readonly { type: string; text?: string }[]
        }
      }
    }
  | { type: string; data?: unknown }

/** Live assistant stream chunks the projection consumes for deltas. */
export type HarnessChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'block-end'; block: { type: string } }
  | { type: 'finish' }
  | { type: string }

/** The stop reason metacodes reports for a harness turn-end reason. */
export function stopReasonOf(reason: { kind: string } | undefined): string {
  if (reason === undefined) return 'unknown'
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    default:
      return reason.kind
  }
}

/**
 * A stateful projection of one run: feed it harness events and stream
 * chunks; it writes metacodes lines and accumulates the final result.
 */
export class RunProjection {
  readonly #sink: LineSink | undefined
  readonly #text = new DeltaJoiner()
  readonly #thinking = new DeltaJoiner()
  #turns = 0
  #toolCalls = 0
  #turnToolCalls = 0
  #usage = zeroUsage()
  #lastText = ''
  #reason:
    { kind: string; error?: { code: string; message: string } } | undefined

  /**
   * @param sink - where live lines go; `undefined` only accumulates the result.
   */
  constructor(sink?: LineSink) {
    this.#sink = sink
  }

  #emit(event: StreamEvent): void {
    this.#sink?.write(renderStreamEvent(event))
  }

  /** Consume one live assistant stream chunk (text and thinking deltas). */
  chunk(chunk: HarnessChunk): void {
    switch (chunk.type) {
      case 'text-delta': {
        const text = this.#text.push((chunk as { text: string }).text)
        if (text !== '') this.#emit({ type: 'text', text })
        return
      }
      case 'reasoning-delta': {
        const text = this.#thinking.push((chunk as { text: string }).text)
        if (text !== '') this.#emit({ type: 'thinking', text })
        return
      }
      case 'block-end': {
        const block = (chunk as { block: { type: string } }).block
        const joiner = block.type === 'reasoning' ? this.#thinking : this.#text
        const lost = joiner.flush()
        if (lost !== '')
          this.#emit({
            type: block.type === 'reasoning' ? 'thinking' : 'text',
            text: lost,
          })
        return
      }
      case 'finish': {
        for (const [joiner, kind] of [
          [this.#text, 'text'],
          [this.#thinking, 'thinking'],
        ] as const) {
          const lost = joiner.flush()
          if (lost !== '') this.#emit({ type: kind, text: lost })
        }
        return
      }
      default:
        return
    }
  }

  /** Consume one durable session event. */
  event(event: HarnessEvent): void {
    switch (event.type) {
      case 'step/start': {
        const data = event.data as { step: number }
        this.#turns += 1
        this.#turnToolCalls = 0
        this.#emit({ type: 'turn_begin', turn: data.step })
        return
      }
      case 'assistant/message': {
        const data = event.data as {
          message: { content: readonly { type: string; text?: string }[] }
          usage?: HarnessUsage
        }
        const text = data.message.content
          .filter(
            (block) => block.type === 'text' && typeof block.text === 'string',
          )
          .map((block) => block.text as string)
          .join('')
        if (text !== '') this.#lastText = text
        if (data.usage !== undefined) {
          const usage = toUsage(data.usage)
          this.#usage = addUsage(this.#usage, usage)
          this.#emit({ type: 'usage', ...usage })
        }
        return
      }
      case 'tool/call': {
        const data = event.data as {
          callId: string
          name: string
          arguments: string
        }
        this.#toolCalls += 1
        this.#turnToolCalls += 1
        this.#emit({
          type: 'tool_start',
          id: data.callId,
          name: data.name,
          input: data.arguments,
        })
        return
      }
      case 'tool/result': {
        if (
          'surfaceOp' in event &&
          event.surfaceOp !== undefined &&
          event.surfaceOp !== 'append'
        )
          return
        const message = (event.data as { message: HarnessToolResult }).message
        this.#emit({
          type: 'tool_result',
          id: message.toolCallId,
          is_error: message.isError === true,
          content: message.content
            .filter(
              (block) =>
                block.type === 'text' && typeof block.text === 'string',
            )
            .map((block) => block.text as string)
            .join(''),
        })
        return
      }
      case 'step/end': {
        const data = event.data as { step: number }
        this.#emit({
          type: 'turn_end',
          turn: data.step,
          tool_calls: this.#turnToolCalls,
        })
        return
      }
      case 'turn/end': {
        const data = event.data as {
          reason: { kind: string; error?: { code: string; message: string } }
        }
        this.#reason = data.reason
        this.#emit({
          type: 'run_end',
          turns: this.#turns,
          tool_calls: this.#toolCalls,
          stop_reason: stopReasonOf(data.reason),
        })
        return
      }
      default:
        return
    }
  }

  /** The harness reason that ended the run, when one was observed. */
  get reason():
    { kind: string; error?: { code: string; message: string } } | undefined {
    return this.#reason
  }

  /** The last committed assistant text. */
  get text(): string {
    return this.#lastText
  }

  /** The accumulated result for the terminal `result` line. */
  result(): RunResult {
    return {
      stop_reason: stopReasonOf(this.#reason),
      turns: this.#turns,
      tool_calls: this.#toolCalls,
      usage: this.#usage,
      cost_usd: 0,
      text: this.#lastText,
    }
  }
}

interface HarnessToolResult {
  toolCallId: string
  isError?: boolean
  content: readonly { type: string; text?: string }[]
}
