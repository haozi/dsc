import { describe, expect, test } from 'bun:test'
import { parseArgs } from '../src/args.ts'

describe('parseArgs', () => {
  test('starts the TUI by default', () => {
    expect(parseArgs([])).toEqual({ mode: 'tui' })
  })

  test('keeps run arguments intact', () => {
    expect(parseArgs(['run', 'echo', 'hello world'])).toEqual({
      mode: 'run',
      tokens: ['echo', 'hello world'],
    })
  })

  test('rejects an empty run', () => {
    expect(() => parseArgs(['run'])).toThrow('needs a command')
  })
})
