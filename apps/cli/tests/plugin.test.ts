import { readProfileManifest, writeProfileManifest } from '@dsc/core'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  anchorPathSpec,
  exportsPatch,
  reconcilePlugins,
} from '../src/plugin.ts'
import { createFakeHome, type FakeHome } from './fixtures.ts'

let fake: FakeHome
const savedHome = process.env.DSC_HOME

beforeEach(() => {
  fake = createFakeHome('test', '[]\n')
  process.env.DSC_HOME = fake.home
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = savedHome
  rmSync(fake.home, { recursive: true, force: true })
})

/** Write a package into the profile's node_modules and list it as a dependency. */
function installPackage(
  name: string,
  manifest: Record<string, unknown>,
  depend = true,
): void {
  const dir = join(fake.profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  )
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  if (!depend) return
  const profile = readProfileManifest('dsc', fake.profileDir)
  profile.dependencies = { ...profile.dependencies, [name]: '^1.0.0' }
  writeProfileManifest(fake.profileDir, profile)
}

describe('anchorPathSpec', () => {
  test('anchors relative filesystem specs to the invoking directory', () => {
    expect(anchorPathSpec('.', '/work/plugin')).toBe('/work/plugin')
    expect(anchorPathSpec('../other', '/work/plugin')).toBe('/work/other')
    expect(anchorPathSpec('file:./sub', '/work')).toBe('file:/work/sub')
    expect(anchorPathSpec('link:..', '/work/a')).toBe('link:/work')
    expect(anchorPathSpec('@scope/pkg', '/work')).toBe('@scope/pkg')
    expect(anchorPathSpec('/abs/path', '/work')).toBe('/abs/path')
    expect(anchorPathSpec('add', '/work')).toBe('add')
  })
})

describe('reconcilePlugins', () => {
  test('adds installed dsc and dsh bundles to the layer list and warns on plain packages', () => {
    const before = readProfileManifest('dsc', fake.profileDir)
    installPackage('@x/dsc-bundle', {
      dsc: { bundle: { patch: './cordis.patch.yml' } },
    })
    installPackage('@x/dsh-bundle', {
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    installPackage('@x/plain', {})
    const warnings: string[] = []
    const bundles = reconcilePlugins(
      before,
      fake.profileDir,
      undefined,
      (line) => warnings.push(line),
    )
    expect(bundles).toEqual(['@fake/bundle', '@x/dsc-bundle', '@x/dsh-bundle'])
    expect(
      readProfileManifest('dsc', fake.profileDir).dsc?.profile?.bundles,
    ).toEqual(bundles)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(
      '@x/plain declares no dsc.bundle or dsh.bundle',
    )
    expect(exportsPatch('@x/plain', fake.profileDir)).toBe(false)
    expect(exportsPatch('@x/dsh-bundle', fake.profileDir)).toBe(true)
  })

  test('drops a removed dependency from the layer list but keeps in-box bundles', () => {
    installPackage('@x/dsc-bundle', {
      dsc: { bundle: { patch: './cordis.patch.yml' } },
    })
    reconcilePlugins(
      readProfileManifest('dsc', fake.profileDir),
      fake.profileDir,
      undefined,
      () => {},
    )
    const before = readProfileManifest('dsc', fake.profileDir)
    expect(before.dsc?.profile?.bundles).toContain('@x/dsc-bundle')

    const after = structuredClone(before)
    delete after.dependencies?.['@x/dsc-bundle']
    writeProfileManifest(fake.profileDir, after)
    const bundles = reconcilePlugins(
      before,
      fake.profileDir,
      undefined,
      () => {},
    )
    expect(bundles).toEqual(['@fake/bundle'])
  })

  test('does not warn again for a pre-existing plain dependency', () => {
    installPackage('@x/plain', {})
    const before = readProfileManifest('dsc', fake.profileDir)
    const warnings: string[] = []
    reconcilePlugins(before, fake.profileDir, undefined, (line) =>
      warnings.push(line),
    )
    expect(warnings).toEqual([])
  })
})
