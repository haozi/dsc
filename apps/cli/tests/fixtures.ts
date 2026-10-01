import { initProfile, resolveProfileDir } from '@dsc/core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A throwaway dsc home with one profile holding fake local bundles. */
export interface FakeHome {
  home: string
  profileDir: string
}

/** The `@fake/app` plugin: records its config and args, provides `fakeApp`. */
export const APP_PLUGIN = `
export const name = 'fake-app'
export const inject = ['cmdlineArgs', 'appExit', 'dscProfile', 'launchEnvironment']
export function apply(ctx, config) {
  const record = {
    config,
    args: ctx.cmdlineArgs.get(),
    profile: ctx.dscProfile.name,
    bundles: ctx.dscProfile.bundles,
    home: ctx.dscHomePath(),
    envSource: ctx.launchEnvironment.get('PATH')?.source,
  }
  globalThis.__fakeApp = record
  ctx.provide('fakeApp', record)
  if (config.exitWith !== undefined) ctx.appExit(config.exitWith)
  return () => { globalThis.__fakeApp = undefined }
}
`

/** Create a home with profile `name`, a bundle package, and a plugin package. */
export function createFakeHome(
  name: string,
  bundlePatch: string,
  options: { namespace?: 'dsc' | 'dsh'; pluginSource?: string } = {},
): FakeHome {
  const home = mkdtempSync(join(tmpdir(), 'dsc-home-'))
  const profileDir = resolveProfileDir(name, home)
  initProfile(profileDir, ['@fake/bundle'])
  const modules = join(profileDir, 'node_modules', '@fake')
  const bundleDir = join(modules, 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(
    join(bundleDir, 'package.json'),
    JSON.stringify({
      name: '@fake/bundle',
      version: '0.1.0',
      [options.namespace ?? 'dsc']: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), bundlePatch)
  const appDir = join(modules, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({
      name: '@fake/app',
      version: '0.1.0',
      type: 'module',
      main: 'index.js',
    }),
  )
  writeFileSync(join(appDir, 'index.js'), options.pluginSource ?? APP_PLUGIN)
  return { home, profileDir }
}
