import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderConfigDump } from '../src/dump.ts'
import { parsePatchList } from '../src/patches.ts'
import { PROFILE_ROOT_CONFIG } from '../src/profile.ts'

let dir: string
let rootConfig: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-dump-'))
  rootConfig = join(dir, 'cordis.yml')
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('renderConfigDump', () => {
  test('groups rows by origin and names patching layers, keeping !!js verbatim', () => {
    const base = parsePatchList(
      'dsc',
      'base',
      `- insert:
    - id: a
      name: '@x/a'
      config:
        cwd: !!js process.cwd()
    - id: b
      name: '@x/b'
`,
      'overlay',
    )
    const user = parsePatchList(
      'dsc',
      'user',
      '- id: b\n  disabled: true\n',
      'overlay',
    )
    const warnings: string[] = []
    const out = renderConfigDump(
      'dsc',
      rootConfig,
      [
        { label: '@x/base', patches: base },
        { label: '/home/u/cordis.patch.yml', patches: user },
        { label: 'overlay.yml', patches: [{ id: 'missing', disabled: true }] },
      ],
      (line) => warnings.push(line),
    )
    expect(out).toBe(`# == @x/base
- id: a
  name: '@x/a'
  config:
    cwd: !!js process.cwd()
# == @x/base, patched by /home/u/cordis.patch.yml
- id: b
  name: '@x/b'
  disabled: true
`)
    expect(warnings).toEqual([
      'dsc: [overlay.yml] patch: entry "missing" not found',
    ])
  })

  test('rejects a root that is not an entry list', () => {
    writeFileSync(rootConfig, 'id: x\n')
    expect(() => renderConfigDump('dsc', rootConfig, [])).toThrow(
      /must be a top-level YAML array/,
    )
  })
})
