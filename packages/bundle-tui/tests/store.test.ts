import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import { attachProjection } from '../src/projection.ts'
import { TranscriptStore } from '../src/store.ts'

const initial = {
  model: 'm',
  provider: 'p',
  permission: 'default',
  sessionId: 'session-1',
  cwd: '/work',
}

describe('TranscriptStore', () => {
  test('streams text into one row and freezes it on commit', () => {
    const store = new TranscriptStore(initial)
    let notified = 0
    store.subscribe(() => (notified += 1))
    store.turnBegin()
    store.textDelta('Hel')
    store.textDelta('lo')
    expect(store.getSnapshot().entries).toEqual([
      { seq: 1, kind: 'assistant', text: 'Hello', streaming: true },
    ])
    store.assistantCommitted('Hello!', '', {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    expect(store.getSnapshot().entries).toEqual([
      { seq: 1, kind: 'assistant', text: 'Hello!', streaming: false },
    ])
    expect(store.getSnapshot().usage.input_tokens).toBe(3)
    expect(store.getSnapshot().turns).toBe(1)
    expect(notified).toBeGreaterThan(0)
  })

  test('pairs tool results with their calls', () => {
    const store = new TranscriptStore(initial)
    store.toolStart('c1', 'bash', '{"command":"ls"}')
    store.toolResult('c1', { isError: false, content: 'a' })
    store.toolResult('zz', { isError: true, content: 'lost' })
    expect(store.getSnapshot().entries).toMatchObject([
      {
        kind: 'tool',
        id: 'c1',
        name: 'bash',
        result: { isError: false, content: 'a' },
      },
      { kind: 'tool', id: 'zz', name: '?', result: { isError: true } },
    ])
    expect(store.getSnapshot().toolCalls).toBe(1)
  })

  test('renders turn-end reasons and clears', () => {
    const store = new TranscriptStore(initial)
    store.turnEnd({ kind: 'error', error: { code: 'E', message: 'boom' } })
    store.turnEnd({ kind: 'aborted' })
    store.turnEnd({ kind: 'completed' })
    expect(store.getSnapshot().entries.map((entry) => entry.kind)).toEqual([
      'error',
      'notice',
    ])
    store.clear()
    expect(store.getSnapshot().entries).toEqual([])
  })
})

describe('attachProjection', () => {
  test('projects harness events for the owning agent only', () => {
    const ctx = new Context()
    const store = new TranscriptStore(initial)
    const agent = { session: { id: 'session-1' } }
    const other = { session: { id: 'session-2' } }
    const detach = attachProjection(ctx, agent, store)
    const raw = ctx as unknown as {
      emit(event: string, ...args: unknown[]): void
    }
    const emit = (
      session: object,
      type: string,
      data: unknown,
      extra: object = {},
    ): void => raw.emit('session/event', session, { type, data, ...extra })
    emit(agent.session, 'turn/start', { turn: 1 })
    expect(store.getSnapshot().busy).toBe(true)
    emit(agent.session, 'step/start', { turn: 1, step: 1 })
    raw.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Hi' } },
    })
    raw.emit('agent/assistant-stream', {
      agent: other,
      frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'NO' } },
    })
    emit(agent.session, 'assistant/message', {
      message: {
        content: [
          { type: 'reasoning', text: 'why' },
          { type: 'text', text: 'Hi' },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    emit(agent.session, 'tool/call', {
      callId: 'c1',
      name: 'read',
      arguments: '{}',
    })
    emit(
      agent.session,
      'tool/result',
      {
        message: {
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'file' }],
        },
      },
      { surfaceOp: 'append' },
    )
    emit(other.session, 'tool/call', {
      callId: 'c2',
      name: 'nope',
      arguments: '{}',
    })
    emit(agent.session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(store.getSnapshot().busy).toBe(false)
    expect(store.getSnapshot().entries).toMatchObject([
      { kind: 'assistant', text: 'Hi', streaming: false },
      { kind: 'thinking', text: 'why', streaming: false },
      { kind: 'tool', name: 'read', result: { content: 'file' } },
    ])
    detach()
    emit(agent.session, 'tool/call', {
      callId: 'c3',
      name: 'after',
      arguments: '{}',
    })
    expect(store.getSnapshot().entries).toHaveLength(3)
  })
})
