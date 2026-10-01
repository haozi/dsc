import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { composeEntries, indexRows, parsePatchList } from '../src/patches.ts'
import {
  bundleDeclarationOf,
  healProfilesModuleFallback,
  initProfile,
  listProfiles,
  loadProfile,
  profileBundlesOf,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  withProfileBundles,
} from '../src/profile.ts'
import {
  createInstallation,
  writeBundle,
  type FakeInstallation,
} from './fixtures.ts'

let install: FakeInstallation

beforeEach(() => {
  install = createInstallation(['@fake/base', '@fake/dsh-style'])
  writeBundle(install.modulesDir, {
    name: '@fake/base',
    version: '1.0.0',
    patch: `- insert:
    - id: timer
      name: '@fake/timer'
    - id: app
      name: '@fake/app-plugin'
      config:
        greeting: hello
`,
  })
  writeBundle(install.modulesDir, {
    name: '@fake/dsh-style',
    namespace: 'dsh',
    patch: `- id: app
  config:
    greeting: from-dsh
- insert:
    - id: extra
      name: '@fake/extra'
`,
  })
})

afterEach(() => {
  rmSync(install.root, { recursive: true, force: true })
})

describe('resolveProfileDir', () => {
  test('rejects names that escape the profiles directory', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'node_modules']) {
      expect(() => resolveProfileDir(bad, install.home)).toThrow(
        'invalid profile name',
      )
    }
    expect(resolveProfileDir('tui', install.home)).toBe(
      join(install.home, 'profiles', 'tui'),
    )
  })
})

describe('initProfile', () => {
  test('writes the manifest, root, user layer and pnpm settings once', () => {
    const dir = resolveProfileDir('tui', install.home)
    initProfile(dir, ['@fake/base'])
    const manifest = readProfileManifest('dsc', dir)
    expect(manifest.dsc?.profile?.bundles).toEqual(['@fake/base'])
    expect(existsSync(join(dir, 'cordis.yml'))).toBe(true)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(true)
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      'hoisted',
    )

    writeFileSync(
      join(dir, 'cordis.patch.yml'),
      '- id: app\n  disabled: true\n',
    )
    initProfile(dir, ['@fake/other'])
    expect(readProfileManifest('dsc', dir).dsc?.profile?.bundles).toEqual([
      '@fake/base',
    ])
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain(
      'disabled: true',
    )
    expect(listProfiles(install.home)).toEqual(['tui'])
  })
})

describe('manifest namespaces', () => {
  test('reads dsc and dsh bundle declarations', () => {
    expect(
      bundleDeclarationOf({ dsc: { bundle: { patch: './a.yml' } } }),
    ).toEqual({
      namespace: 'dsc',
      bundle: { patch: './a.yml' },
    })
    expect(
      bundleDeclarationOf({ dsh: { bundle: { patch: './b.yml' } } })?.namespace,
    ).toBe('dsh')
    expect(bundleDeclarationOf({ name: 'plain' })).toBeUndefined()
  })

  test('reads and rewrites the profile bundle list in its own namespace', () => {
    expect(profileBundlesOf({ dsh: { profile: { bundles: ['x'] } } })).toEqual([
      'x',
    ])
    expect(profileBundlesOf({})).toEqual([])
    const dshProfile = withProfileBundles(
      { dsh: { profile: { bundles: ['x'] } } },
      ['x', 'y'],
    )
    expect(dshProfile.dsh?.profile?.bundles).toEqual(['x', 'y'])
    expect(dshProfile.dsc).toBeUndefined()
    const fresh = withProfileBundles({}, ['z'])
    expect(fresh.dsc?.profile?.bundles).toEqual(['z'])
  })
})

describe('resolveBundleDir', () => {
  test('prefers the installation over the profile directory', () => {
    const dir = resolveProfileDir('tui', install.home)
    initProfile(dir, ['@fake/base'])
    writeBundle(join(dir, 'node_modules'), {
      name: '@fake/base',
      version: '9.9.9',
    })
    writeBundle(join(dir, 'node_modules'), { name: '@fake/local-only' })

    expect(
      resolveBundleDir('dsc', '@fake/base', install.installAnchor, dir),
    ).toBe(join(install.modulesDir, '@fake/base'))
    expect(
      resolveBundleDir('dsc', '@fake/local-only', install.installAnchor, dir),
    ).toBe(join(dir, 'node_modules', '@fake/local-only'))
    expect(() =>
      resolveBundleDir('dsc', '@fake/missing', install.installAnchor, dir),
    ).toThrow(/cannot resolve profile bundle "@fake\/missing"/)
  })
})

describe('loadProfile', () => {
  test('initializes a templated profile and composes its layers in order', () => {
    const profile = loadProfile(
      'dsc',
      'tui',
      install.installAnchor,
      install.home,
      {
        templates: { tui: ['@fake/base', '@fake/dsh-style'] },
      },
    )
    expect(profile.layers.map((layer) => layer.packageName)).toEqual([
      '@fake/base',
      '@fake/dsh-style',
    ])
    expect(profile.layers[0]?.version).toBe('1.0.0')

    const rows = indexRows(
      composeEntries([
        ...profile.layers.map((layer) => layer.patches),
        profile.patches,
      ]),
    )
    expect([...rows.keys()]).toEqual(['timer', 'app', 'extra'])
    expect(rows.get('app')?.config).toEqual({ greeting: 'from-dsh' })
  })

  test('fails loud on an unknown profile and a bundle-less layer', () => {
    expect(() =>
      loadProfile('dsc', 'nope', install.installAnchor, install.home),
    ).toThrow(/profile "nope" does not exist/)
    writeBundle(install.modulesDir, { name: '@fake/plain', namespace: 'none' })
    const dir = resolveProfileDir('plain', install.home)
    initProfile(dir, ['@fake/plain'])
    expect(() =>
      loadProfile('dsc', 'plain', install.installAnchor, install.home),
    ).toThrow(/declares no dsc.bundle or dsh.bundle/)
  })

  test('skips the user layer on request', () => {
    const dir = resolveProfileDir('tui', install.home)
    initProfile(dir, ['@fake/base'])
    writeFileSync(join(dir, 'cordis.patch.yml'), 'not: [valid')
    expect(() =>
      loadProfile('dsc', 'tui', install.installAnchor, install.home),
    ).toThrow(/failed to parse overlay/)
    const profile = loadProfile(
      'dsc',
      'tui',
      install.installAnchor,
      install.home,
      {
        userLayer: false,
      },
    )
    expect(profile.patches).toEqual([])
  })
})

describe('healProfilesModuleFallback', () => {
  test('links the installation closure under profiles/node_modules', () => {
    writeBundle(install.modulesDir, { name: '@fake/timer', namespace: 'none' })
    writeBundle(install.modulesDir, {
      name: '@fake/base',
      dependencies: { '@fake/timer': '*' },
    })
    const count = healProfilesModuleFallback(
      install.installAnchor,
      install.home,
    )
    const fallback = join(install.home, 'profiles', 'node_modules')
    expect(count).toBe(4)
    for (const name of [
      '@fake/app',
      '@fake/base',
      '@fake/dsh-style',
      '@fake/timer',
    ]) {
      expect(lstatSync(join(fallback, name)).isSymbolicLink()).toBe(true)
    }
    expect(
      healProfilesModuleFallback(install.installAnchor, install.home),
    ).toBe(4)
  })
})

describe('parsePatchList', () => {
  test('keeps !!js expressions as unevaluated nodes', () => {
    const patches = parsePatchList(
      'dsc',
      'x.yml',
      '- id: a\n  config:\n    cwd: !!js process.cwd()\n',
      'overlay',
    )
    expect(patches[0]?.config).toEqual({ cwd: { __jsExpr: 'process.cwd()' } })
    expect(() => parsePatchList('dsc', 'x.yml', 'id: a\n', 'overlay')).toThrow(
      /must be a top-level YAML array/,
    )
    expect(() => parsePatchList('dsc', 'x.yml', '- 1\n', 'overlay')).toThrow(
      /must be a mapping/,
    )
  })
})
