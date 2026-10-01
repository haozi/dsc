/**
 * `dsc login` / `dsc logout`: manage the credential store the DeepSeek
 * Harness adapters read, `$DSC_HOME/.credentials.yaml`, without booting a
 * tree. The document is the harness's version-1 layout — `version: 1` and a
 * `refs:` mapping from reference names (`DEEPSEEK_API_KEY`) to secrets — so
 * a key stored here is exactly what `dsh-credentials-local` resolves for
 * every provider route, in the web Models page and in dsc alike. Writes go
 * through the YAML document model so comments and untouched entries survive,
 * land with mode 0600, and never print a secret.
 * @module @dsc/cli/auth
 */
import { resolveDscHome } from '@dsc/core'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Document, isMap, parseDocument, YAMLMap } from 'yaml'
import { NAME } from './install.ts'

/** Basename of the credential store inside the home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The reference the DeepSeek adapter resolves by default. */
export const DEFAULT_REF = 'DEEPSEEK_API_KEY'

/** The grammar a reference name must follow (POSIX environment identifier). */
const REF_NAME = /^[A-Z_][A-Z0-9_]*$/i

/** The credential store's path under the resolved home. */
export function credentialsPath(home: string = resolveDscHome()): string {
  return join(home, CREDENTIALS_FILENAME)
}

/** Reject a reference name the harness would not admit. */
export function assertRefName(name: string): void {
  if (!REF_NAME.test(name))
    throw new Error(
      `${NAME}: credential reference "${name}" must be an environment-style identifier`,
    )
}

/** Load the store as a document, or an empty version-1 document when absent. */
export function loadStore(path: string): Document {
  if (!existsSync(path)) {
    const document = new Document({ version: 1, refs: {} })
    document.commentBefore = ` dsc credential store — written by 'dsc login'. Values are secrets; keep this file private.`
    return document
  }
  const document = parseDocument(readFileSync(path, 'utf8'), {
    prettyErrors: true,
    uniqueKeys: true,
  }) as Document
  if (document.errors.length > 0)
    throw new Error(
      `${NAME}: invalid credential store ${path}: ${document.errors.map((error) => error.message).join('; ')}`,
    )
  const root = document.contents as YAMLMap | null | undefined
  if (
    root === null ||
    root === undefined ||
    (isMap(root) && root.items.length === 0)
  )
    document.contents = document.createNode({ version: 1, refs: {} }) as YAMLMap
  else if (!isMap(root))
    throw new Error(`${NAME}: ${path} must be a YAML mapping`)
  else if (!root.has('version')) {
    // The pre-release flat layout: nest the existing entries under refs.
    const refs = new YAMLMap()
    for (const pair of [...root.items]) refs.items.push(pair)
    root.items.length = 0
    root.set('version', 1)
    root.set('refs', refs)
  } else if (root.get('version') !== 1)
    throw new Error(
      `${NAME}: ${path} declares version ${JSON.stringify(root.get('version'))}; dsc writes version 1`,
    )
  return document
}

/** The `refs` mapping of a loaded store, created when missing. */
function refsOf(document: Document): YAMLMap {
  const root = document.contents as YAMLMap
  let refs = root.get('refs')
  if (refs === undefined || refs === null) {
    refs = new YAMLMap()
    root.set('refs', refs)
  }
  if (!isMap(refs))
    throw new Error(
      `${NAME}: the credential store's refs section must be a mapping`,
    )
  return refs
}

/** Write the store atomically with mode 0600 under a 0700 home. */
export function saveStore(path: string, document: Document): void {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, document.toString(), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** Reference names currently stored (never the values). */
export function storedRefs(path: string): string[] {
  if (!existsSync(path)) return []
  const refs = refsOf(loadStore(path))
  return refs.items.map((pair) =>
    String((pair.key as { value?: unknown }).value ?? pair.key),
  )
}

/** Store one secret under `ref`. */
export function storeKey(path: string, ref: string, secret: string): void {
  assertRefName(ref)
  if (secret.trim() === '')
    throw new Error(`${NAME}: an empty key cannot be stored`)
  const document = loadStore(path)
  refsOf(document).set(ref, secret.trim())
  saveStore(path, document)
}

/** Remove `ref`; returns whether it was present. */
export function removeKey(path: string, ref: string): boolean {
  assertRefName(ref)
  if (!existsSync(path)) return false
  const document = loadStore(path)
  const refs = refsOf(document)
  if (!refs.has(ref)) return false
  refs.delete(ref)
  saveStore(path, document)
  return true
}

/** Remove every stored reference. */
export function removeAll(path: string): number {
  if (!existsSync(path)) return 0
  const document = loadStore(path)
  const refs = refsOf(document)
  const count = refs.items.length
  refs.items.length = 0
  saveStore(path, document)
  return count
}

/** A masked hint of where a key comes from, never the secret itself. */
function describeSource(
  ref: string,
  path: string,
  env: NodeJS.ProcessEnv,
): string {
  const fromEnv = env[ref]
  if (fromEnv !== undefined && fromEnv !== '')
    return `${ref}: launching environment (wins over the store)`
  return storedRefs(path).includes(ref) ? `${ref}: ${path}` : `${ref}: not set`
}

/** Render `dsc login status`. */
export function renderStatus(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const refs = new Set<string>([DEFAULT_REF, ...storedRefs(path)])
  for (const name of Object.keys(env))
    if (/_API_KEY$/.test(name) && env[name] !== '') refs.add(name)
  return [...refs]
    .sort()
    .map((ref) => describeSource(ref, path, env))
    .join('\n')
}

/** Prompt for a secret on the terminal without echoing it. */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          `${NAME}: no terminal to prompt on; pass --api-key <key> instead`,
        ),
      )
      return
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    })
    const muted = rl as unknown as { _writeToOutput?: (text: string) => void }
    const original = muted._writeToOutput
    let asked = false
    muted._writeToOutput = (text: string) => {
      if (!asked) {
        asked = true
        original?.call(rl, text)
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stderr.write('\n')
      resolve(answer)
    })
  })
}

/** Options of one `dsc login` invocation. */
export interface LoginOptions {
  apiKey?: string
  ref: string
  status: boolean
}

/** Run `dsc login`. */
export async function runLogin(
  options: LoginOptions,
  path: string = credentialsPath(),
): Promise<number> {
  if (options.status) {
    process.stdout.write(renderStatus(path) + '\n')
    return 0
  }
  const secret =
    options.apiKey ??
    (await promptSecret(`${NAME}: paste the API key for ${options.ref}: `))
  storeKey(path, options.ref, secret)
  process.stderr.write(
    `${NAME}: stored ${options.ref} in ${path} (mode 0600). The secret was not printed.\n`,
  )
  return 0
}

/** Run `dsc logout`. */
export function runLogout(
  options: { ref: string; all: boolean },
  path: string = credentialsPath(),
): number {
  if (options.all) {
    const count = removeAll(path)
    process.stderr.write(
      `${NAME}: removed ${count} stored credential${count === 1 ? '' : 's'} from ${path}\n`,
    )
    return 0
  }
  const removed = removeKey(path, options.ref)
  process.stderr.write(
    removed
      ? `${NAME}: removed ${options.ref} from ${path}\n`
      : `${NAME}: ${options.ref} was not stored in ${path}\n`,
  )
  return 0
}
