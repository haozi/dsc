/**
 * Facts about this dsc installation: the package anchor every bundle
 * resolves from first, the version, and the shipped profile templates.
 * @module @dsc/cli/install
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Diagnostic prefix on every launcher message. */
export const NAME = 'dsc'

/** Absolute path of this installation's package.json (first resolution anchor). */
export const INSTALL_ANCHOR = fileURLToPath(
  new URL('../package.json', import.meta.url),
)

/** This app's version, read from its checked-in package.json. */
export function readVersion(): string {
  const manifest = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as {
    version?: string
  }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/** The DeepSeek Harness core every shipped profile starts from. */
export const BASE_BUNDLE = '@deepseek-ai/dsh-base'

/** Shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  tui: [BASE_BUNDLE, '@dsc/bundle-tui'],
  headless: [BASE_BUNDLE, '@deepseek-ai/dsh-headless'],
  web: [BASE_BUNDLE, '@deepseek-ai/dsh-web-app'],
}

/** The bundle list a `dsc plugin` init uses for a name with no shipped template. */
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = [BASE_BUNDLE]
