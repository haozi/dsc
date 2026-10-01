import { describe, expect, test } from 'vitest'
import { parseDscArgs } from '../src/args.ts'

const exits: number[] = []
const exit = (code: number): never => {
  exits.push(code)
  throw new Error(`exit ${code}`)
}

describe('parseDscArgs', () => {
  test('boots the tui profile by default and forwards inner arguments', () => {
    expect(parseDscArgs([], '1.0.0', exit)).toEqual({
      mode: 'profile',
      profile: 'tui',
      patches: [],
      args: [],
    })
    expect(parseDscArgs(['--resume', 'abc', '-p', 'x'], '1.0.0', exit)).toEqual(
      {
        mode: 'profile',
        profile: 'tui',
        patches: [],
        args: ['--resume', 'abc', '-p', 'x'],
      },
    )
  })

  test('-p, --print and - select the headless profile', () => {
    expect(parseDscArgs(['-p', 'hi', '--json'], '1.0.0', exit)).toEqual({
      mode: 'profile',
      profile: 'headless',
      patches: [],
      args: ['-p', 'hi', '--json'],
    })
    expect(parseDscArgs(['-'], '1.0.0', exit)).toMatchObject({
      profile: 'headless',
      args: ['-'],
    })
    expect(parseDscArgs(['--print', 'x'], '1.0.0', exit)).toMatchObject({
      profile: 'headless',
    })
    expect(
      parseDscArgs(['--profile', 'tui', '-p', 'x'], '1.0.0', exit),
    ).toMatchObject({
      profile: 'tui',
      args: ['-p', 'x'],
    })
  })

  test('stops parsing launcher flags at the first inner token', () => {
    expect(
      parseDscArgs(
        [
          '--profile',
          'headless',
          '--patch',
          'a.yml',
          '--patch',
          'b.yml',
          '--json',
          '-p',
          'hi',
        ],
        '1.0.0',
        exit,
      ),
    ).toEqual({
      mode: 'profile',
      profile: 'headless',
      patches: ['a.yml', 'b.yml'],
      args: ['--json', '-p', 'hi'],
    })
    expect(parseDscArgs(['--profile', 'web', '--help'], '1.0.0', exit)).toEqual(
      {
        mode: 'profile',
        profile: 'web',
        patches: [],
        args: ['--help'],
      },
    )
  })

  test('web is an alias of --profile web', () => {
    expect(parseDscArgs(['web', '--port', '3080'], '1.0.0', exit)).toEqual({
      mode: 'profile',
      profile: 'web',
      patches: [],
      args: ['--port', '3080'],
    })
    expect(parseDscArgs(['web', '--dump-config'], '1.0.0', exit)).toEqual({
      mode: 'dump-config',
      profile: 'web',
      defaultOnly: false,
      patches: [],
    })
  })

  test('--web and serve map onto the web profile', () => {
    expect(parseDscArgs(['--web'], '1.0.0', exit)).toEqual({
      mode: 'profile',
      profile: 'web',
      patches: [],
      args: [],
    })
    expect(
      parseDscArgs(['--web', '7777', '--host', '0.0.0.0'], '1.0.0', exit),
    ).toMatchObject({
      profile: 'web',
      args: ['--port', '7777', '--host', '0.0.0.0'],
    })
    expect(parseDscArgs(['serve'], '1.0.0', exit)).toMatchObject({
      profile: 'web',
      args: ['--no-open'],
    })
    expect(
      parseDscArgs(['serve', '--patch', 'x.yml', '8080'], '1.0.0', exit),
    ).toMatchObject({
      profile: 'web',
      patches: ['x.yml'],
      args: ['--no-open', '--port', '8080'],
    })
  })

  test('resolves config dumps and rejects their conflicts', () => {
    expect(
      parseDscArgs(
        ['--profile', 'tui', '--dump-default-config'],
        '1.0.0',
        exit,
      ),
    ).toEqual({
      mode: 'dump-config',
      profile: 'tui',
      defaultOnly: true,
      patches: [],
    })
    exits.length = 0
    expect(() =>
      parseDscArgs(
        ['--profile', 'tui', '--dump-config', '--dump-default-config'],
        '1',
        exit,
      ),
    ).toThrow('exit 1')
    expect(() =>
      parseDscArgs(['--profile', 'tui', '--dump-config', 'extra'], '1', exit),
    ).toThrow('exit 1')
    expect(() =>
      parseDscArgs(
        ['--profile', 'tui', '--dump-default-config', '--patch', 'x'],
        '1',
        exit,
      ),
    ).toThrow('exit 1')
    expect(exits).toEqual([1, 1, 1])
  })

  test('plugin forwards pnpm arguments and requires a profile', () => {
    expect(
      parseDscArgs(
        ['plugin', '--profile', 'tui', 'add', '@x/y'],
        '1.0.0',
        exit,
      ),
    ).toEqual({
      mode: 'plugin',
      profile: 'tui',
      args: ['add', '@x/y'],
    })
    exits.length = 0
    expect(() => parseDscArgs(['plugin', 'add', '@x/y'], '1', exit)).toThrow(
      'exit 1',
    )
    expect(() =>
      parseDscArgs(['plugin', '--profile', 'tui'], '1', exit),
    ).toThrow('exit 1')
    expect(exits).toEqual([1, 1])
  })

  test('doctor resolves its flags', () => {
    expect(parseDscArgs(['doctor'], '1.0.0', exit)).toEqual({
      mode: 'doctor',
      json: false,
      strict: false,
    })
    expect(
      parseDscArgs(['doctor', '--json', '--strict'], '1.0.0', exit),
    ).toEqual({
      mode: 'doctor',
      json: true,
      strict: true,
    })
  })

  test('login and logout resolve their flags', () => {
    expect(parseDscArgs(['login', '--api-key', 'sk-1'], '1.0.0', exit)).toEqual(
      {
        mode: 'login',
        apiKey: 'sk-1',
        ref: 'DEEPSEEK_API_KEY',
        status: false,
      },
    )
    expect(parseDscArgs(['login', 'status'], '1.0.0', exit)).toMatchObject({
      mode: 'login',
      status: true,
    })
    expect(
      parseDscArgs(['logout', '--ref', 'X_API_KEY'], '1.0.0', exit),
    ).toEqual({
      mode: 'logout',
      ref: 'X_API_KEY',
      all: false,
    })
    expect(parseDscArgs(['logout', '--all'], '1.0.0', exit)).toMatchObject({
      all: true,
    })
    exits.length = 0
    expect(() => parseDscArgs(['login', 'nope'], '1', exit)).toThrow('exit 1')
  })

  test('--version resolves the identity mode, with --json', () => {
    expect(parseDscArgs(['--version'], '1.0.0', exit)).toEqual({
      mode: 'version',
      json: false,
    })
    expect(parseDscArgs(['-V', '--json'], '1.0.0', exit)).toEqual({
      mode: 'version',
      json: true,
    })
  })

  test('help and version are terminal', () => {
    exits.length = 0
    const out = process.stdout.write.bind(process.stdout)
    const captured: string[] = []
    process.stdout.write = ((chunk: string) => {
      captured.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      expect(() => parseDscArgs(['--help'], '1.0.0', exit)).toThrow('exit 0')
    } finally {
      process.stdout.write = out
    }
    expect(exits).toEqual([0])
    expect(captured.join('')).toContain('Usage: dsc')
  })
})
