import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import {
  dispatchLine,
  parseSlash,
  type CommandContext,
} from '../src/commands.ts'
import { TranscriptStore } from '../src/store.ts'

function harness(options: { commands?: boolean } = {}): {
  command: CommandContext
  store: TranscriptStore
  calls: string[]
} {
  const ctx = new Context()
  const store = new TranscriptStore({
    model: 'm',
    provider: 'p',
    permission: 'default',
    sessionId: 'session-1',
    cwd: process.cwd(),
  })
  const calls: string[] = []
  if (options.commands) {
    ctx.provide('commands', {
      list: () => [
        { name: 'compact', description: 'Compact the conversation' },
        { name: 'help', description: 'shadowed' },
      ],
      execute: async (_agent: unknown, line: string) => {
        calls.push(line)
        if (line.startsWith('/compact'))
          return { result: { kind: 'success' as const, text: 'compacted' } }
        if (line.startsWith('/fail'))
          return { result: { kind: 'error' as const, text: 'nope' } }
        return undefined
      },
    })
  }
  const command: CommandContext = {
    ctx,
    agent: { session: { id: 'session-1' }, cancel: () => calls.push('cancel') },
    store,
    selection: { current: { provider: 'p', model: 'm' }, assembled: undefined },
    cwd: process.cwd(),
    setPermission: (mode) => calls.push(`permission:${mode}`),
    exit: () => calls.push('exit'),
  }
  return { command, store, calls }
}

const lastCommand = (store: TranscriptStore): string => {
  const entry = [...store.getSnapshot().entries]
    .reverse()
    .find((row) => row.kind === 'command')
  return entry?.kind === 'command' ? entry.text : ''
}

describe('parseSlash', () => {
  test('splits the verb from its raw input', () => {
    expect(parseSlash('/model use x')).toEqual({ name: 'model', args: 'use x' })
    expect(parseSlash('/HELP')).toEqual({ name: 'help', args: '' })
    expect(parseSlash('not a command')).toBeUndefined()
    expect(parseSlash('/')).toBeUndefined()
  })
})

describe('dispatchLine', () => {
  test('routes prompts, blanks, and the shell lane', async () => {
    const { command, store } = harness()
    expect(await dispatchLine('hello', command)).toBe('prompt')
    expect(await dispatchLine('   ', command)).toBe('handled')
    expect(await dispatchLine('!echo shell-lane', command)).toBe('handled')
    expect(lastCommand(store)).toBe('shell-lane')
  })

  test('built-in verbs win over harness commands and /quit aliases /exit', async () => {
    const { command, store, calls } = harness({ commands: true })
    expect(await dispatchLine('/help', command)).toBe('handled')
    expect(lastCommand(store)).toContain('/compact')
    expect(lastCommand(store)).not.toContain('shadowed')
    expect(calls).toEqual([])
    expect(await dispatchLine('/quit', command)).toBe('exit')
    expect(calls).toEqual(['exit'])
  })

  test('/model and /permissions update the session state', async () => {
    const { command, store, calls } = harness()
    await dispatchLine('/model', command)
    expect(lastCommand(store)).toBe('p / m')
    await dispatchLine('/model use deepseek-reasoner', command)
    expect(command.selection.current).toEqual({
      provider: 'p',
      model: 'deepseek-reasoner',
    })
    await dispatchLine('/model other/x', command)
    expect(command.selection.current).toEqual({ provider: 'other', model: 'x' })
    expect(store.getSnapshot().model).toBe('x')
    await dispatchLine('/permissions plan', command)
    expect(calls).toEqual(['permission:plan'])
    expect(store.getSnapshot().permission).toBe('plan')
    await dispatchLine('/permissions nope', command)
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({
      kind: 'error',
      text: 'unknown permission mode: nope',
    })
  })

  test('falls through to the harness command registry', async () => {
    const { command, store, calls } = harness({ commands: true })
    expect(await dispatchLine('/compact now', command)).toBe('handled')
    expect(calls).toEqual(['/compact now'])
    expect(lastCommand(store)).toBe('compacted')
    await dispatchLine('/fail', command)
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({
      kind: 'error',
      text: 'nope',
    })
    await dispatchLine('/missing', command)
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({
      kind: 'error',
      text: 'unknown command: /missing (try /help)',
    })
  })

  test('/cost and /session read the store', async () => {
    const { command, store } = harness()
    await dispatchLine('/cost', command)
    expect(lastCommand(store)).toContain('input: 0')
    await dispatchLine('/session', command)
    expect(lastCommand(store)).toContain('session: session-1')
  })
})
