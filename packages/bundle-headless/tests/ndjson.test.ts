import { describe, expect, test } from 'vitest'
import {
  DeltaJoiner,
  MAX_FIELD_PREVIEW,
  RunProjection,
  renderResult,
  renderStreamEvent,
  stopReasonOf,
  truncateUtf8,
} from '../src/ndjson.ts'

const lines = (): {
  sink: { write(line: string): void }
  out: Record<string, unknown>[]
} => {
  const out: Record<string, unknown>[] = []
  return {
    sink: {
      write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    },
    out,
  }
}

describe('truncateUtf8', () => {
  test('cuts at a code-point boundary and flags the cut', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false })
    expect(truncateUtf8('a€b', 2)).toEqual({ text: 'a', truncated: true })
    expect(truncateUtf8('a€b', 4)).toEqual({ text: 'a€', truncated: true })
  })
})

describe('DeltaJoiner', () => {
  test('holds back a split surrogate pair and rejoins it', () => {
    const joiner = new DeltaJoiner()
    const emoji = '😀'
    expect(joiner.push('hi ' + emoji[0]!)).toBe('hi ')
    expect(joiner.push(emoji[1]! + ' there')).toBe(emoji + ' there')
    expect(joiner.flush()).toBe('')
  })

  test('turns a never-completed half into U+FFFD at flush', () => {
    const joiner = new DeltaJoiner()
    expect(joiner.push('😀'[0]!)).toBe('')
    expect(joiner.flush()).toBe('\uFFFD')
  })
})

describe('renderStreamEvent', () => {
  test('previews tool input and output with explicit truncation', () => {
    const long = 'x'.repeat(MAX_FIELD_PREVIEW + 5)
    const start = JSON.parse(
      renderStreamEvent({
        type: 'tool_start',
        id: 'c1',
        name: 'bash',
        input: long,
      }),
    ) as Record<string, unknown>
    expect(start).toMatchObject({
      type: 'tool_start',
      id: 'c1',
      name: 'bash',
      truncated: true,
    })
    expect((start.input as string).length).toBe(MAX_FIELD_PREVIEW)
    const result = JSON.parse(
      renderStreamEvent({
        type: 'tool_result',
        id: 'c1',
        is_error: false,
        content: 'ok',
      }),
    )
    expect(result).toEqual({
      type: 'tool_result',
      id: 'c1',
      is_error: false,
      content: 'ok',
    })
  })

  test('sanitizes lone surrogates so every line is valid UTF-8', () => {
    const line = renderStreamEvent({ type: 'text', text: 'a' + '\uD83D' + 'b' })
    expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line)
    expect(JSON.parse(line)).toEqual({ type: 'text', text: 'a\uFFFDb' })
  })
})

describe('RunProjection', () => {
  test('projects a run in the metacodes dialect', () => {
    const { sink, out } = lines()
    const projection = new RunProjection(sink)
    projection.event({ type: 'turn/start', data: { turn: 1 } })
    projection.event({ type: 'step/start', data: { turn: 1, step: 1 } })
    projection.chunk({ type: 'reasoning-delta', text: 'think' })
    projection.chunk({ type: 'text-delta', text: 'Let me ' })
    projection.chunk({ type: 'text-delta', text: 'look.' })
    projection.event({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'Let me look.' }] },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      },
    })
    projection.event({
      type: 'tool/call',
      data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    projection.event({
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        message: {
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'a.txt' }],
        },
      },
    })
    projection.event({ type: 'step/end', data: { turn: 1, step: 1 } })
    projection.event({ type: 'step/start', data: { turn: 1, step: 2 } })
    projection.chunk({ type: 'text-delta', text: 'Done.' })
    projection.event({
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'text', text: 'Done.' }] },
        usage: { inputTokens: 20, outputTokens: 3 },
      },
    })
    projection.event({ type: 'step/end', data: { turn: 1, step: 2 } })
    projection.event({
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })

    expect(out).toEqual([
      { type: 'turn_begin', turn: 1 },
      { type: 'thinking', text: 'think' },
      { type: 'text', text: 'Let me ' },
      { type: 'text', text: 'look.' },
      {
        type: 'usage',
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
      { type: 'tool_start', id: 'c1', name: 'bash', input: '{"command":"ls"}' },
      { type: 'tool_result', id: 'c1', is_error: false, content: 'a.txt' },
      { type: 'turn_end', turn: 1, tool_calls: 1 },
      { type: 'turn_begin', turn: 2 },
      { type: 'text', text: 'Done.' },
      {
        type: 'usage',
        input_tokens: 20,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      { type: 'turn_end', turn: 2, tool_calls: 0 },
      { type: 'run_end', turns: 2, tool_calls: 1, stop_reason: 'end_turn' },
    ])
    expect(JSON.parse(renderResult(projection.result()))).toEqual({
      type: 'result',
      stop_reason: 'end_turn',
      turns: 2,
      tool_calls: 1,
      input_tokens: 30,
      output_tokens: 8,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
      cost_usd: 0,
      text: 'Done.',
    })
  })

  test('ignores replaced surface nodes and records an error reason', () => {
    const { sink, out } = lines()
    const projection = new RunProjection(sink)
    projection.event({
      type: 'tool/result',
      surfaceOp: { op: 'replace' },
      data: { message: { toolCallId: 'c9', content: [] } },
    })
    projection.event({
      type: 'turn/end',
      data: {
        turn: 1,
        reason: { kind: 'error', error: { code: 'E', message: 'boom' } },
      },
    })
    expect(out).toEqual([
      { type: 'run_end', turns: 0, tool_calls: 0, stop_reason: 'error' },
    ])
    expect(projection.reason?.kind).toBe('error')
    expect(stopReasonOf({ kind: 'max-tokens' })).toBe('max_tokens')
    expect(stopReasonOf(undefined)).toBe('unknown')
  })

  test('accumulates silently without a sink', () => {
    const projection = new RunProjection()
    projection.chunk({ type: 'text-delta', text: 'x' })
    projection.event({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'final' }] } },
    })
    expect(projection.text).toBe('final')
  })
})
