/**
 * `dsc --version [--json]`: the version and build identity, as metacodes
 * prints them — the first line is `dsc <semver>`, the rest names the runtime,
 * the platform, the home, and every runtime package this installation pins
 * (cordis stack and DeepSeek Harness bundles) with its resolved version.
 * @module @dsc/cli/version
 */
import {
  dscHomeDisplay,
  packageDirFromAnchor,
  readManifest,
  resolveDscHome,
} from '@dsc/core'
import { join } from 'node:path'
import {
  INSTALL_ANCHOR,
  NAME,
  PROFILE_TEMPLATES,
  readVersion,
} from './install.ts'

/** One pinned runtime package and what resolved for it. */
export interface RuntimeAsset {
  name: string
  /** The range this installation declares. */
  declared: string
  /** The version that resolves from the installation, or `null` when missing. */
  version: string | null
}

/** The build identity document. */
export interface BuildIdentity {
  name: string
  version: string
  node: string
  platform: string
  arch: string
  home: string
  install_anchor: string
  profiles: Record<string, readonly string[]>
  runtime_assets: RuntimeAsset[]
}

/** Packages reported in the identity, in print order. */
const REPORTED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsc/core',
  '@dsc/bundle-headless',
  '@dsc/bundle-tui',
]

/** Resolve the identity from the installation. */
export function buildIdentity(): BuildIdentity {
  const app = readManifest(NAME, INSTALL_ANCHOR)
  const declared = { ...app.dependencies }
  const coreAnchor = packageDirFromAnchor(INSTALL_ANCHOR, '@dsc/core')
  if (coreAnchor !== undefined) {
    const core = readManifest(NAME, join(coreAnchor, 'package.json'))
    for (const [name, range] of Object.entries(core.dependencies ?? {}))
      declared[name] ??= range
  }
  const runtime_assets = REPORTED.map((name): RuntimeAsset => {
    const dir = packageDirFromAnchor(INSTALL_ANCHOR, name)
    const version =
      dir === undefined
        ? null
        : (readManifest(NAME, join(dir, 'package.json')).version ?? null)
    return { name, declared: declared[name] ?? '(transitive)', version }
  })
  return {
    name: NAME,
    version: readVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    home: resolveDscHome(),
    install_anchor: INSTALL_ANCHOR,
    profiles: PROFILE_TEMPLATES,
    runtime_assets,
  }
}

/** Render the identity as text. */
export function renderVersionText(identity: BuildIdentity): string {
  const lines = [
    `${identity.name} ${identity.version}`,
    `node ${identity.node} ${identity.platform}-${identity.arch}`,
    `home ${dscHomeDisplay(identity.home)} (${identity.home})`,
    `install ${identity.install_anchor}`,
    'profiles:',
    ...Object.entries(identity.profiles).map(
      ([name, bundles]) => `  ${name.padEnd(9)} ${bundles.join(' + ')}`,
    ),
    'runtime assets:',
  ]
  const width = Math.max(
    ...identity.runtime_assets.map((asset) => asset.name.length),
  )
  for (const asset of identity.runtime_assets)
    lines.push(
      `  ${asset.name.padEnd(width)}  ${asset.version ?? 'MISSING'}  (declared ${asset.declared})`,
    )
  return lines.join('\n') + '\n'
}

/** Render the identity as one JSON document. */
export function renderVersionJson(identity: BuildIdentity): string {
  return JSON.stringify(identity, undefined, 2) + '\n'
}
