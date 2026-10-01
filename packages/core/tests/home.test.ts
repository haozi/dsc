import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  bridgeDshHome,
  dscHomeDisplay,
  expandHomePath,
  resolveDscHome,
} from '../src/home.ts'

describe('resolveDscHome', () => {
  test('defaults to ~/.dsc', () => {
    expect(resolveDscHome(undefined, {})).toBe(join(homedir(), '.dsc'))
  })

  test('reads DSC_HOME and treats a blank value as unset', () => {
    expect(resolveDscHome(undefined, { DSC_HOME: '/tmp/dsc-home' })).toBe(
      resolve('/tmp/dsc-home'),
    )
    expect(resolveDscHome(undefined, { DSC_HOME: '   ' })).toBe(
      join(homedir(), '.dsc'),
    )
  })

  test('prefers an explicit value and expands a tilde', () => {
    expect(resolveDscHome('~/custom', { DSC_HOME: '/elsewhere' })).toBe(
      join(homedir(), 'custom'),
    )
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('/abs')).toBe('/abs')
  })
})

describe('dscHomeDisplay', () => {
  test('names the default home symbolically', () => {
    expect(dscHomeDisplay(join(homedir(), '.dsc'))).toBe('~/.dsc')
    expect(dscHomeDisplay('/srv/dsc')).toBe('$DSC_HOME')
  })
})

describe('bridgeDshHome', () => {
  test('points DSH_HOME at the dsc home when unset', () => {
    const env: NodeJS.ProcessEnv = { DSC_HOME: '/tmp/dsc-bridge' }
    expect(bridgeDshHome(env)).toBe(resolve('/tmp/dsc-bridge'))
    expect(env.DSH_HOME).toBe(resolve('/tmp/dsc-bridge'))
  })

  test('respects an explicit DSH_HOME', () => {
    const env: NodeJS.ProcessEnv = { DSC_HOME: '/tmp/a', DSH_HOME: '/tmp/b' }
    expect(bridgeDshHome(env)).toBe('/tmp/b')
    expect(env.DSH_HOME).toBe('/tmp/b')
  })
})
