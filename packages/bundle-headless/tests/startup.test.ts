import { Context } from '@deepseek-ai/cordis'
import { cmdlineInternals, provideCmdline } from '@dsc/core'
import { afterEach, describe, expect, test } from 'vitest'
import { HEADLESS_SERVICE, resolvePermission } from '../src/options.ts'
import { apply, resolveOptions } from '../src/startup.ts'

const originalOut = cmdlineInternals.stdout
const originalErr = cmdlineInternals.stderr

afterEach(() => {
  cmdlineInternals.stdout = originalOut
  cmdlineInternals.stderr = originalErr
})

function parse(args: string[]): {
  ctx: Context
  exits: number[]
  err: string[]
} {
  const ctx = new Context()
  const exits: number[] = []
  const err: string[] = []
  cmdlineInternals.stdout = { write: () => true }
  cmdlineInternals.stderr = { write: (chunk: string) => err.push(chunk) }
  provideCmdline(ctx, { args, exit: (code) => exits.push(code) })
  apply(ctx)
  return { ctx, exits, err }
}

describe('resolvePermission', () => {
  test('maps every metacodes mode onto a sandbox and approval pair', () => {
    expect(resolvePermission('default')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'ask',
      preset: 'workspace-write',
    })
    expect(resolvePermission('plan').sandboxMode).toBe('read-only')
    expect(resolvePermission('auto').approvalPolicy).toBe('never')
    expect(resolvePermission('dontAsk').preset).toBe('dont-ask')
    expect(resolvePermission('bypassPermissions')).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      preset: 'danger-full-access',
    })
  })
})

describe('resolveOptions', () => {
  test('accepts the prompt positionally or through -p', () => {
    expect(
      resolveOptions(['run', 'tests'], { permission: 'default' }).prompt,
    ).toBe('run tests')
    expect(
      resolveOptions([], { print: 'x', permission: 'default' }).prompt,
    ).toBe('x')
    expect(resolveOptions(['-'], { permission: 'default' }).prompt).toBe('-')
    expect(() => resolveOptions([], { permission: 'default' })).toThrow(
      /a prompt is required/,
    )
    expect(() =>
      resolveOptions(['a'], { print: 'b', permission: 'default' }),
    ).toThrow(/give the prompt once/)
    expect(
      resolveOptions([], { permission: 'default', dumpPrompt: true })
        .dumpPrompt,
    ).toBe(true)
  })
})

describe('startup plugin', () => {
  test('publishes dscHeadless with the resolved permission', () => {
    const { ctx, exits } = parse([
      '-p',
      'hello world',
      '--json',
      '--stream-json',
      '--model',
      'deepseek-chat',
      '--permission',
      'auto',
      '--session',
      'session-1',
    ])
    expect(exits).toEqual([])
    expect(ctx.get(HEADLESS_SERVICE)).toEqual({
      prompt: 'hello world',
      json: true,
      streamJson: true,
      sessionId: 'session-1',
      model: 'deepseek-chat',
      provider: undefined,
      permission: 'auto',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      preset: 'dont-ask',
      dumpPrompt: false,
    })
  })

  test('rejects an unknown permission and a missing prompt as usage errors', () => {
    const bad = parse(['-p', 'x', '--permission', 'yolo'])
    expect(bad.exits).toEqual([1])
    expect(bad.ctx.get(HEADLESS_SERVICE)).toBeUndefined()
    expect(bad.err.join('')).toContain('expected one of')
    const missing = parse([])
    expect(missing.exits).toEqual([1])
    expect(missing.err.join('')).toContain('a prompt is required')
  })

  test('--help is terminal and provides nothing', () => {
    const { ctx, exits } = parse(['--help'])
    expect(exits).toEqual([0])
    expect(ctx.get(HEADLESS_SERVICE)).toBeUndefined()
  })
})
