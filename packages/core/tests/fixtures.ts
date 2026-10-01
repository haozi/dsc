import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A throwaway "installation": an app package with bundle dependencies. */
export interface FakeInstallation {
  root: string
  home: string
  installAnchor: string
  modulesDir: string
}

/** Options for one fake bundle package. */
export interface FakeBundle {
  name: string
  version?: string
  /** `dsc` or `dsh` manifest namespace for the bundle declaration. */
  namespace?: 'dsc' | 'dsh' | 'none'
  patch?: string
  dependencies?: Record<string, string>
}

/** Create a temporary installation with an app manifest and a home. */
export function createInstallation(
  appDependencies: string[] = [],
): FakeInstallation {
  const root = mkdtempSync(join(tmpdir(), 'dsc-install-'))
  const app = join(root, 'app')
  const modulesDir = join(root, 'node_modules')
  mkdirSync(app, { recursive: true })
  mkdirSync(modulesDir, { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const name of appDependencies) dependencies[name] = '*'
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      { name: '@fake/app', version: '1.2.3', dependencies },
      undefined,
      2,
    ),
  )
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, home, installAnchor: join(app, 'package.json'), modulesDir }
}

/** Write a bundle package into a `node_modules` directory. */
export function writeBundle(modulesDir: string, bundle: FakeBundle): string {
  const dir = join(modulesDir, bundle.name)
  mkdirSync(dir, { recursive: true })
  const namespace = bundle.namespace ?? 'dsc'
  const manifest: Record<string, unknown> = {
    name: bundle.name,
    version: bundle.version ?? '0.0.1',
    dependencies: bundle.dependencies ?? {},
  }
  if (namespace !== 'none')
    manifest[namespace] = { bundle: { patch: './cordis.patch.yml' } }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(manifest, undefined, 2),
  )
  writeFileSync(join(dir, 'cordis.patch.yml'), bundle.patch ?? '[]\n')
  return dir
}

/** Write a plain ESM plugin module into a package directory. */
export function writePluginModule(dir: string, source: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), source)
  const manifestPath = join(dir, 'package.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({
      name: dir.split('/').slice(-1)[0],
      type: 'module',
      main: 'index.js',
    }),
  )
}
