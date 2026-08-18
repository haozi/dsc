import { describe, expect, test } from 'bun:test'
import { Runtime, tokenize } from '../src/index.ts'

describe('Runtime', () => {
  test('unloads plugin effects in reverse order', async () => {
    const disposed: string[] = []
    const runtime = new Runtime()
    await runtime.mount([
      {
        name: 'first',
        apply: () => () => {
          disposed.push('first')
        },
      },
      {
        name: 'second',
        apply: () => () => {
          disposed.push('second')
        },
      },
    ])

    await runtime.dispose()

    expect(disposed).toEqual(['second', 'first'])
  })
})

describe('tokenize', () => {
  test('supports quoted interactive arguments', () => {
    expect(tokenize('echo "hello world" \'from bun\'')).toEqual([
      'echo',
      'hello world',
      'from bun',
    ])
  })

  test('preserves empty quoted arguments', () => {
    expect(tokenize('echo "" tail')).toEqual(['echo', '', 'tail'])
  })

  test('rejects an unclosed quote', () => {
    expect(() => tokenize('echo "hello')).toThrow('Unclosed " quote')
  })
})
