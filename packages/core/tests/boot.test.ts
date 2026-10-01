import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  assertEntriesActivated,
  boot,
  createProcessShutdown,
  installFailLoud,
  rootIncludeOf,
  watchPatchFile,
} from '../src/boot.ts'
import { createAppReady, parseCmdline, provideCmdline } from '../src/cmdline.ts'
import { loadOptionalPatches, type PatchOptions } from '../src/patches.ts'
import { PROFILE_ROOT_CONFIG } from '../src/profile.ts'
import {
  createInstallation,
  writePluginModule,
  type FakeInstallation,
} from './fixtures.ts'

let install: FakeInstallation
let profileDir: string
let rootConfig: string
let ctx: Context | undefined

const probePlugin = `
export const name = 'probe'
export const inject = ['cmdlineArgs', 'appExit']
export function apply(ctx, config) {
  globalThis.__dscProbe = { config, args: ctx.cmdlineArgs.get(), home: ctx.dscHomePath('x'), dsh: ctx.dshHomePath('x') }
  ctx.provide('probe', { config })
  return () => { globalThis.__dscProbe = undefined }
}
`

const consumerPlugin = `
export const name = 'consumer'
export const inject = ['probe']
export function apply(ctx, config) {
  globalThis.__dscConsumer = { greeting: config.greeting, probe: ctx.probe.config }
}
`

const failingPlugin = `
export const name = 'failing'
export function apply() { throw new Error('boom from plugin') }
`

beforeEach(() => {
  install = createInstallation()
  profileDir = join(install.home, 'profiles', 'test')
  mkdirSync(join(profileDir, 'node_modules', '@fake'), { recursive: true })
  writePluginModule(
    join(profileDir, 'node_modules', '@fake', 'probe'),
    probePlugin,
  )
  writePluginModule(
    join(profileDir, 'node_modules', '@fake', 'consumer'),
    consumerPlugin,
  )
  writePluginModule(
    join(profileDir, 'node_modules', '@fake', 'failing'),
    failingPlugin,
  )
  rootConfig = join(profileDir, 'cordis.yml')
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  process.env.DSC_HOME = install.home
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  delete process.env.DSC_HOME
  delete (globalThis as { __dscProbe?: unknown }).__dscProbe
  delete (globalThis as { __dscConsumer?: unknown }).__dscConsumer
  rmSync(install.root, { recursive: true, force: true })
})

const basePatches: PatchOptions[] = [
  {
    insert: [
      { id: 'probe', name: '@fake/probe', config: { level: 1 } },
      { id: 'consumer', name: '@fake/consumer', config: { greeting: 'hi' } },
    ],
  },
]

describe('boot', () => {
  test('mounts bare-named plugins from the profile directory with host services', async () => {
    ctx = await boot('dsc', rootConfig, basePatches, (host) => {
      provideCmdline(host, { args: ['--flag', 'value'], exit: () => {} })
    })
    const probe = (globalThis as { __dscProbe?: Record<string, unknown> })
      .__dscProbe
    expect(probe?.config).toEqual({ level: 1 })
    expect(probe?.args).toEqual(['--flag', 'value'])
    expect(probe?.home).toBe(join(install.home, 'x'))
    expect(probe?.dsh).toBe(join(install.home, 'x'))
    expect((globalThis as { __dscConsumer?: unknown }).__dscConsumer).toEqual({
      greeting: 'hi',
      probe: { level: 1 },
    })
    expect(rootIncludeOf(ctx)).toBeDefined()
  })

  test('rethrows a plugin activation failure with its stack after disposing', async () => {
    await expect(
      boot('dsc', rootConfig, [
        { insert: [{ id: 'bad', name: '@fake/failing' }] },
      ]),
    ).rejects.toThrow(/plugin tree failed to load[\s\S]*boom from plugin/)
  })

  test('names a pending entry and its missing service', async () => {
    await expect(
      boot('dsc', rootConfig, [
        { insert: [{ id: 'consumer', name: '@fake/consumer', config: {} }] },
      ]),
    ).rejects.toThrow(/@fake\/consumer: pending \(waiting for service: probe\)/)
  })

  test('skips disabled rows', async () => {
    ctx = await boot('dsc', rootConfig, [
      { insert: [{ id: 'bad', name: '@fake/failing', disabled: true }] },
    ])
    await expect(assertEntriesActivated(ctx, 'dsc')).resolves.toBeUndefined()
  })

  test('applies a changed user patch layer through watchPatchFile', async () => {
    const userLayer = join(profileDir, 'cordis.patch.yml')
    writeFileSync(userLayer, '[]\n')
    const compose = (): PatchOptions[] => [
      ...basePatches,
      ...(loadOptionalPatches('dsc', userLayer) ?? []),
    ]
    ctx = await boot('dsc', rootConfig, compose(), (host) => {
      provideCmdline(host, { args: [], exit: () => {} })
    })
    const stop = watchPatchFile(ctx, {
      binName: 'dsc',
      filename: userLayer,
      compose,
      debounceMs: 20,
    })
    try {
      // Native watchers settle asynchronously; give the registration a moment.
      await delay(150)
      writeFileSync(
        userLayer,
        '- id: consumer\n  config:\n    greeting: changed\n',
      )
      for (let i = 0; i < 200; i += 1) {
        await delay(25)
        const consumer = (
          globalThis as { __dscConsumer?: { greeting: string } }
        ).__dscConsumer
        if (consumer?.greeting === 'changed') break
      }
      expect(
        (globalThis as { __dscConsumer?: { greeting: string } }).__dscConsumer
          ?.greeting,
      ).toBe('changed')
    } finally {
      stop()
    }
  })
})

describe('parseCmdline', () => {
  test('runs the action on a parse and requests exit on help', async () => {
    const { Command } = await import('commander')
    const exits: number[] = []
    ctx = await boot('dsc', rootConfig, [], (host) => {
      provideCmdline(host, {
        args: ['--port', '8080'],
        exit: (code) => exits.push(code),
      })
    })
    let port: string | undefined
    const program = new Command()
      .name('app')
      .option('--port <n>')
      .action((options: { port?: string }) => {
        port = options.port
      })
    parseCmdline(ctx, program)
    expect(port).toBe('8080')
    expect(exits).toEqual([])

    await ctx.fiber.dispose()
    ctx = await boot('dsc', rootConfig, [], (host) => {
      provideCmdline(host, {
        args: ['--help'],
        exit: (code) => exits.push(code),
      })
    })
    const { cmdlineInternals } = await import('../src/cmdline.ts')
    const originalOut = cmdlineInternals.stdout
    const captured: string[] = []
    cmdlineInternals.stdout = { write: (chunk: string) => captured.push(chunk) }
    try {
      parseCmdline(
        ctx,
        new Command().name('app').action(() => {}),
      )
    } finally {
      cmdlineInternals.stdout = originalOut
    }
    expect(exits).toEqual([0])
    expect(captured.join('')).toContain('Usage: app')
  })

  test('throws when the launcher provided no command line', async () => {
    const { Command } = await import('commander')
    ctx = await boot('dsc', rootConfig, [])
    expect(() =>
      parseCmdline(
        ctx!,
        new Command().name('app').action(() => {}),
      ),
    ).toThrow(/must provide ctx.cmdlineArgs and ctx.appExit/)
  })
})

describe('createAppReady', () => {
  test('fires listeners once and immediately after commit', () => {
    const ready = createAppReady()
    const calls: string[] = []
    ready.service.onReady(() => calls.push('early'))
    ready.commit()
    ready.commit()
    ready.service.onReady(() => calls.push('late'))
    expect(calls).toEqual(['early', 'late'])
  })
})

describe('createProcessShutdown', () => {
  test('coalesces shutdown calls and completes with the first code', async () => {
    const codes: string[] = []
    let disposed = 0
    const shutdown = createProcessShutdown(
      async () => {
        disposed += 1
      },
      (code) => codes.push(`force:${code}`),
      (code) => codes.push(`complete:${code}`),
      1_000,
    )
    await Promise.all([shutdown.shutdown(0), shutdown.shutdown(3)])
    expect(disposed).toBe(1)
    expect(codes).toEqual(['complete:0'])
  })

  test('interrupt forces the exit after dispose and immediately on repeat', async () => {
    const codes: string[] = []
    let release!: () => void
    const shutdown = createProcessShutdown(
      () => new Promise<void>((resolve) => (release = resolve)),
      (code) => codes.push(`force:${code}`),
      (code) => codes.push(`complete:${code}`),
      1_000,
    )
    shutdown.interrupt(130)
    await delay(0)
    shutdown.interrupt(130)
    expect(codes).toEqual(['force:130'])
    release()
    await delay(0)
    expect(codes).toEqual(['force:130'])
  })

  test('forces the exit when dispose overruns the grace', async () => {
    const codes: string[] = []
    const shutdown = createProcessShutdown(
      () => new Promise<void>(() => {}),
      (code) => codes.push(`force:${code}`),
      (code) => codes.push(`complete:${code}`),
      10,
    )
    void shutdown.shutdown(2)
    await delay(30)
    expect(codes).toEqual(['force:2'])
  })
})

describe('installFailLoud', () => {
  test('reports one rejection and exits after releasing the terminal', async () => {
    const stderr: string[] = []
    const exits: number[] = []
    const handlers = new Map<string, (err: unknown) => void>()
    const proc = {
      on: (event: string, handler: (err: unknown) => void) => {
        handlers.set(event, handler)
        return proc
      },
      off: (event: string) => {
        handlers.delete(event)
        return proc
      },
      exit: (code: number) => {
        exits.push(code)
        return undefined as never
      },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'exit' | 'stderr'>
    let released = false
    const uninstall = installFailLoud('dsc', proc, async () => {
      released = true
    })
    handlers.get('unhandledRejection')?.(new Error('late failure'))
    handlers.get('unhandledRejection')?.(new Error('second'))
    await delay(0)
    expect(released).toBe(true)
    expect(exits).toEqual([1])
    expect(stderr.join('')).toContain(
      'dsc: fatal load failure: Error: late failure',
    )
    uninstall()
    expect(handlers.size).toBe(0)
  })
})
