/**
 * Patch-list files and their composition.
 *
 * A profile tree is never written as a whole: it is an empty root entry list
 * plus ordered patch layers (each bundle's `cordis.patch.yml`, the profile's
 * own user layer, the home-level layer, `--patch` overlays). Every layer is a
 * top-level YAML array of `@deepseek-ai/cordis-plugin-include` patch entries —
 * `insert` lists and id-targeted overrides — with `!!js` scalars evaluated
 * lazily by the Loader in the targeted row's own context. Composition goes
 * through the include's own `applyEntryPatches`, so an offline dump and the
 * booted tree can never disagree.
 * @module @dsc/core/patches
 */
import {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as yaml from 'js-yaml'
import { readFileSync } from 'node:fs'

export type { EntryOptions, PatchOptions }

/** Sink for skipped-patch diagnostics, one rendered line per call. */
export type PatchWarn = (line: string) => void

/**
 * Parse one patch list.
 * @param binName - diagnostic prefix.
 * @param file - the source path, quoted in errors.
 * @param content - the file's text.
 * @param label - what to call the list in errors (`patches`, `overlay`).
 * @throws when the document is not a YAML array of mappings.
 */
export function parsePatchList(
  binName: string,
  file: string,
  content: string,
  label: string,
): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(
      `${binName}: failed to parse ${label} ${file}: ${String(error)}`,
    )
  }
  if (!Array.isArray(parsed))
    throw new Error(
      `${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`,
    )
  parsed.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error(
        `${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`,
      )
  })
  return parsed as PatchOptions[]
}

/**
 * Load an optional patch-list file. A missing file means "no layer"; an
 * unreadable, unparsable, or non-array file throws, because a present layer
 * that cannot apply is a misconfiguration that must fail loud at boot.
 * @returns the patches, or `undefined` when the file does not exist.
 */
export function loadOptionalPatches(
  binName: string,
  file: string,
): PatchOptions[] | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(
      `${binName}: failed to read patches ${file}: ${String(error)}`,
    )
  }
  return parsePatchList(binName, file, content, 'patches')
}

/**
 * Load a required overlay: a bundle's patch file or a `--patch` path. The
 * caller named this file, so its absence is an error, not "no overlay".
 */
export function loadOverlayPatches(
  binName: string,
  file: string,
): PatchOptions[] {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(
      `${binName}: failed to read overlay ${file}: ${String(error)}`,
    )
  }
  return parsePatchList(binName, file, content, 'overlay')
}

/**
 * Compose patch layers into the effective entry list over an empty root with
 * the single `applyEntryPatches` call the boot include makes.
 * @param layers - patch lists in application order.
 * @param warn - sink for skipped-patch diagnostics; silent by default (boot repeats them).
 */
export function composeEntries(
  layers: readonly (readonly PatchOptions[])[],
  warn: PatchWarn = () => {},
): EntryOptions[] {
  return applyEntryPatches(
    [],
    structuredClone(layers.flat()) as PatchOptions[],
    (message: string, ...args: unknown[]) => {
      let index = 0
      warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
    },
  )
}

/** Index composed rows by id (nested group rows included). */
export function indexRows(
  entries: readonly EntryOptions[],
): Map<string, EntryOptions> {
  const rows = new Map<string, EntryOptions>()
  const walk = (list: readonly EntryOptions[]): void => {
    for (const row of list) {
      if (typeof row.id === 'string') rows.set(row.id, row)
      if (row.group && Array.isArray(row.config))
        walk(row.config as EntryOptions[])
    }
  }
  walk(entries)
  return rows
}

/** Serialize an entry list in the include dialect (`!!js` printed verbatim). */
export function dumpEntries(entries: readonly EntryOptions[]): string {
  return yaml.dump(entries, { schema: entryListSchema, noRefs: true })
}
