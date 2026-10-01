import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  removeAll,
  removeKey,
  renderStatus,
  storedRefs,
  storeKey,
} from '../src/auth.ts'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-auth-'))
  path = join(dir, '.credentials.yaml')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('credential store', () => {
  test('writes the harness version-1 layout with mode 0600', () => {
    storeKey(path, 'DEEPSEEK_API_KEY', ' sk-secret ')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('version: 1')
    expect(text).toContain('refs:')
    expect(text).toContain('DEEPSEEK_API_KEY: sk-secret')
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(storedRefs(path)).toEqual(['DEEPSEEK_API_KEY'])
  })

  test('preserves comments and other entries across writes', () => {
    writeFileSync(
      path,
      '# keep me\nversion: 1\nrefs:\n  OTHER_API_KEY: keep # inline\n  DEEPSEEK_API_KEY: old\n',
    )
    storeKey(path, 'DEEPSEEK_API_KEY', 'new')
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# keep me')
    expect(text).toContain('OTHER_API_KEY: keep # inline')
    expect(text).toContain('DEEPSEEK_API_KEY: new')
    expect(removeKey(path, 'DEEPSEEK_API_KEY')).toBe(true)
    expect(removeKey(path, 'DEEPSEEK_API_KEY')).toBe(false)
    expect(storedRefs(path)).toEqual(['OTHER_API_KEY'])
    expect(removeAll(path)).toBe(1)
    expect(storedRefs(path)).toEqual([])
  })

  test('migrates the pre-release flat layout and rejects bad input', () => {
    writeFileSync(path, 'DEEPSEEK_API_KEY: flat\n')
    storeKey(path, 'X_API_KEY', 'x')
    expect(readFileSync(path, 'utf8')).toMatch(
      /version: 1\nrefs:\n  DEEPSEEK_API_KEY: flat\n  X_API_KEY: x/,
    )
    expect(() => storeKey(path, 'bad name', 'x')).toThrow(
      /environment-style identifier/,
    )
    expect(() => storeKey(path, 'OK', '  ')).toThrow(/empty key/)
    writeFileSync(path, 'version: 2\nrefs: {}\n')
    expect(() => storeKey(path, 'OK', 'x')).toThrow(/declares version 2/)
  })

  test('status names sources without printing secrets', () => {
    storeKey(path, 'DEEPSEEK_API_KEY', 'sk-secret')
    const status = renderStatus(path, { OTHER_API_KEY: 'env-secret' })
    expect(status).toContain(`DEEPSEEK_API_KEY: ${path}`)
    expect(status).toContain('OTHER_API_KEY: launching environment')
    expect(status).not.toContain('secret')
    expect(renderStatus(path, { DEEPSEEK_API_KEY: 'env' })).toContain(
      'wins over the store',
    )
  })
})
