import { dispatch, type Runtime } from '@tiny-harness/core'
import { afterEach, describe, expect, test } from 'vitest'
import { boot } from '../src/boot.ts'

let runtime: Runtime | undefined

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
})

describe('runtime', () => {
  test('mounts commands from the default profile', async () => {
    runtime = await boot()
    const result = await dispatch(runtime, ['echo', 'hello', 'world'])

    expect(result).toEqual({ ok: true, message: 'hello world' })
    expect(runtime.require('transcript').getSnapshot()).toMatchObject([
      { seq: 1, kind: 'input', text: 'echo hello world' },
      { seq: 2, kind: 'output', text: 'hello world' },
    ])
  })

  test('turns command failures into transcript events', async () => {
    runtime = await boot()
    const result = await dispatch(runtime, 'missing')

    expect(result.ok).toBe(false)
    expect(runtime.require('transcript').getSnapshot().at(-1)).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('Unknown command'),
    })
  })

  test('clear is implemented as a command effect', async () => {
    runtime = await boot()
    await dispatch(runtime, 'echo before')
    await dispatch(runtime, 'clear')

    expect(runtime.require('transcript').getSnapshot()).toEqual([])
    expect(runtime.require('transcript').getEvents().at(-1)).toMatchObject({
      kind: 'clear',
      seq: 4,
    })
  })
})
