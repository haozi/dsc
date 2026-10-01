import type { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironment } from '@dsc/core'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderProfileDump } from '../src/dump-config.ts'
import { packageNameOf, pluginInventory } from '../src/dump-plugins.ts'
import {
  composeProfile,
  homePatchPath,
  resolveTelemetryPatch,
  runProfile,
} from '../src/profile-boot.ts'
import { createFakeHome, type FakeHome } from './fixtures.ts'

const BUNDLE = `- insert:
    - id: app
      name: '@fake/app'
      config:
        greeting: hello
    - id: session-telemetry-otel
      name: '@fake/app'
      disabled: true
`

let fake: FakeHome
let ctx: Context | undefined
const savedEnv = { ...process.env }

beforeEach(() => {
  fake = createFakeHome('test', BUNDLE)
  process.env.DSC_HOME = fake.home
  delete process.env.DSH_TELEMETRY_DISABLED
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  delete (globalThis as { __fakeApp?: unknown }).__fakeApp
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(fake.home, { recursive: true, force: true })
})

describe('composeProfile', () => {
  test('stacks bundle, profile, home, and overlay layers in order', () => {
    writeFileSync(
      join(fake.profileDir, 'cordis.patch.yml'),
      '- id: app\n  config:\n    greeting: profile\n',
    )
    writeFileSync(homePatchPath(), '- id: app\n  config:\n    greeting: home\n')
    const overlay = join(fake.home, 'overlay.yml')
    writeFileSync(overlay, '- id: app\n  config:\n    greeting: overlay\n')
    const composed = composeProfile('test', [overlay])
    expect(composed.profile.layers.map((layer) => layer.packageName)).toEqual([
      '@fake/bundle',
    ])
    expect(composed.rows.get('app')?.config).toEqual({ greeting: 'overlay' })
    expect(composed.homePatches).toHaveLength(1)
    expect(composed.overlays).toHaveLength(1)
    expect(readFileSync(join(fake.profileDir, 'cordis.yml'), 'utf8')).toContain(
      '[]',
    )
    expect(
      existsSync(join(fake.home, 'profiles', 'node_modules', '@dsc', 'cli')),
    ).toBe(true)
  })

  test('appends the telemetry disable patch when the switch is set', () => {
    process.env.DSH_TELEMETRY_DISABLED = '0'
    const composed = composeProfile('test', [])
    expect(composed.overlays).toEqual([
      { id: 'session-telemetry-otel', disabled: true },
    ])
    expect(resolveTelemetryPatch('', true)).toBeUndefined()
    expect(resolveTelemetryPatch('1', false)).toBeUndefined()
  })
})

describe('renderProfileDump', () => {
  test('labels each layer and honors --dump-default-config', () => {
    writeFileSync(
      join(fake.profileDir, 'cordis.patch.yml'),
      '- id: app\n  disabled: true\n',
    )
    const full = renderProfileDump('test', false, [])
    expect(full).toContain(
      '# == @fake/bundle, patched by ' +
        join(fake.profileDir, 'cordis.patch.yml'),
    )
    expect(full).toContain('disabled: true')
    const defaults = renderProfileDump('test', true, [])
    expect(defaults).toContain('# == @fake/bundle\n')
    expect(defaults).not.toContain('patched by')
  })
})

describe('pluginInventory', () => {
  test('resolves every row to its package and inserting layer', () => {
    writeFileSync(
      join(fake.profileDir, 'cordis.patch.yml'),
      "- insert:\n    - id: extra\n      name: '@fake/app'\n      disabled: !!js process.platform === 'win32'\n",
    )
    const inventory = pluginInventory('test', [])
    expect(inventory.layers).toMatchObject([
      { package: '@fake/bundle', version: '0.1.0' },
    ])
    expect(inventory.entries).toMatchObject([
      {
        id: 'app',
        name: '@fake/app',
        disabled: false,
        inserted_by: '@fake/bundle',
        resolved: { package: '@fake/app', version: '0.1.0', source: 'profile' },
      },
      { id: 'session-telemetry-otel', disabled: true },
      {
        id: 'extra',
        disabled: { expr: "process.platform === 'win32'" },
        inserted_by: join(fake.profileDir, 'cordis.patch.yml'),
      },
    ])
    expect(packageNameOf('@deepseek-ai/dsh-plugin-manager/tools')).toBe(
      '@deepseek-ai/dsh-plugin-manager',
    )
    expect(packageNameOf('commander/esm')).toBe('commander')
    expect(packageNameOf('./local.js')).toBeUndefined()
  })
})

describe('runProfile', () => {
  test('boots the tree with launcher services and watches the user layers', async () => {
    const environment = createLaunchEnvironment([
      { source: 'process', values: process.env },
    ])
    const result = await runProfile({
      environment,
      profile: 'test',
      patchFiles: [],
      args: ['--flag', 'x'],
    })
    ctx = result.ctx
    const record = (globalThis as { __fakeApp?: Record<string, unknown> })
      .__fakeApp
    expect(record).toMatchObject({
      config: { greeting: 'hello' },
      args: ['--flag', 'x'],
      profile: 'test',
      bundles: ['@fake/bundle'],
      home: fake.home,
      envSource: 'process',
    })
    expect(ctx.get('appReady')).toBeDefined()
    expect(ctx.get('dscProfile')).toMatchObject({
      name: 'test',
      dir: fake.profileDir,
    })
  })

  test('accepts a dsh-namespaced bundle unchanged', async () => {
    rmSync(fake.home, { recursive: true, force: true })
    fake = createFakeHome('test', BUNDLE, { namespace: 'dsh' })
    process.env.DSC_HOME = fake.home
    const environment = createLaunchEnvironment([
      { source: 'process', values: process.env },
    ])
    const result = await runProfile({
      environment,
      profile: 'test',
      patchFiles: [],
      args: [],
    })
    ctx = result.ctx
    expect(
      (globalThis as { __fakeApp?: Record<string, unknown> }).__fakeApp,
    ).toMatchObject({
      bundles: ['@fake/bundle'],
    })
  })
})
