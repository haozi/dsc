import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createLaunchEnvironment,
  isBootstrapOnly,
  loadLayeredEnv,
  readEnvLayer,
} from '../src/env.ts'

let dir: string
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-env-'))
  savedEnv = { ...process.env }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

describe('isBootstrapOnly', () => {
  test('rejects process, runtime, and network bootstrap names', () => {
    expect(isBootstrapOnly('PATH')).toBe(true)
    expect(isBootstrapOnly('node_options')).toBe(true)
    expect(isBootstrapOnly('DSC_HOME')).toBe(true)
    expect(isBootstrapOnly('DSH_HOME')).toBe(true)
    expect(isBootstrapOnly('DEEPSEEK_API_KEY')).toBe(false)
  })
})

describe('readEnvLayer', () => {
  test('returns undefined for a missing file', () => {
    expect(readEnvLayer('dsc', dir)).toBeUndefined()
  })

  test('throws on a bootstrap-only name before applying anything', () => {
    writeFileSync(join(dir, '.env'), 'PATH=/evil\n')
    expect(() => readEnvLayer('dsc', dir)).toThrow(/sets "PATH"/)
  })
})

describe('loadLayeredEnv', () => {
  test('applies project then home values without replacing inherited ones', () => {
    const home = join(dir, 'home')
    const project = join(dir, 'project')
    mkdirSync(home, { recursive: true })
    mkdirSync(project, { recursive: true })
    process.env.DSC_HOME = home
    process.env.T_INHERITED = 'from-process'
    delete process.env.T_PROJECT
    delete process.env.T_USER
    writeFileSync(
      join(project, '.env'),
      'T_INHERITED=from-project\nT_PROJECT=p\nSHARED=project\n',
    )
    writeFileSync(join(home, '.env'), 'T_USER=u\nSHARED=home\n')

    const snapshot = loadLayeredEnv('dsc', project, () => {})

    expect(process.env.T_INHERITED).toBe('from-process')
    expect(process.env.T_PROJECT).toBe('p')
    expect(process.env.T_USER).toBe('u')
    expect(process.env.SHARED).toBe('project')
    expect(snapshot.get('T_INHERITED')).toMatchObject({
      value: 'from-process',
      source: 'process',
    })
    expect(snapshot.get('SHARED')).toMatchObject({
      value: 'project',
      source: 'project-env',
      path: join(project, '.env'),
    })
    expect(snapshot.getFrom('SHARED', ['user-env'])).toMatchObject({
      value: 'home',
      source: 'user-env',
    })
    delete process.env.SHARED
  })
})

describe('createLaunchEnvironment', () => {
  test('searches layers in trust order regardless of input order', () => {
    const snapshot = createLaunchEnvironment([
      { source: 'user-env', path: '/u/.env', values: { A: 'user' } },
      { source: 'process', values: { A: 'proc', B: undefined } },
    ])
    expect(snapshot.get('A')?.source).toBe('process')
    expect(snapshot.get('B')).toBeUndefined()
  })
})
