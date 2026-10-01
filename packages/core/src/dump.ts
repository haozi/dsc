/**
 * Offline config dumps: compose the profile's layers through the include's
 * own patch algorithm without booting or evaluating `!!js`, and render the
 * result as one loadable YAML document whose `# ==` comments name the file
 * that contributed each run of rows and the layers that patched them.
 * @module @dsc/core/dump
 */
import {
  applyEntryPatches,
  entryListSchema,
} from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { EntryOptions, PatchOptions } from './patches.ts'

/** One labelled patch layer. */
export interface DumpLayer {
  label: string
  patches: readonly PatchOptions[]
}

interface Provenance {
  origin: string
  patchedBy: string[]
}

/**
 * Print a profile composition with source comments.
 * @param binName - diagnostic prefix.
 * @param absoluteConfigPath - the root entry list `boot()` would include.
 * @param layers - overlay layers in application order (later wins).
 * @param warn - sink for skipped-patch diagnostics; defaults to stderr.
 */
export function renderConfigDump(
  binName: string,
  absoluteConfigPath: string,
  layers: readonly DumpLayer[],
  warn: (line: string) => void = (line) =>
    void process.stderr.write(`${line}\n`),
): string {
  let content: string
  try {
    content = readFileSync(absoluteConfigPath, 'utf8')
  } catch (error) {
    throw new Error(
      `${binName}: failed to read config ${absoluteConfigPath}: ${String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(
      `${binName}: failed to parse config ${absoluteConfigPath}: ${String(error)}`,
    )
  }
  if (!Array.isArray(parsed))
    throw new Error(
      `${binName}: config ${absoluteConfigPath} must be a top-level YAML array of entries`,
    )
  const base = parsed as EntryOptions[]
  const baseLabel = basename(absoluteConfigPath)
  const snapshot = (count: number, warnings: string[]): EntryOptions[] =>
    applyEntryPatches(
      base,
      structuredClone(
        layers.slice(0, count).flatMap((layer) => layer.patches),
      ) as PatchOptions[],
      (message: string, ...args: unknown[]) => {
        let index = 0
        warnings.push(
          message.replace(/%C/g, () => JSON.stringify(args[index++])),
        )
      },
    )
  let previous = base
  let previousWarnings: string[] = []
  const provenance: Provenance[] = base.map(() => ({
    origin: baseLabel,
    patchedBy: [],
  }))
  let composed = base
  for (let count = 1; count <= layers.length; count += 1) {
    const layer = layers[count - 1]
    if (layer === undefined) continue
    const warnings: string[] = []
    composed = snapshot(count, warnings)
    for (const line of warnings.slice(previousWarnings.length))
      warn(`${binName}: [${layer.label}] ${line}`)
    const before = previous.map((entry) => JSON.stringify(entry))
    for (let index = 0; index < composed.length; index += 1) {
      if (index >= before.length)
        provenance.push({ origin: layer.label, patchedBy: [] })
      else if (JSON.stringify(composed[index]) !== before[index])
        provenance[index]?.patchedBy.push(layer.label)
    }
    previous = composed
    previousWarnings = warnings
  }
  return groupedDump(composed, provenance)
}

function groupedDump(
  composed: readonly EntryOptions[],
  provenance: readonly Provenance[],
): string {
  const lines: string[] = []
  let currentLabel: string | undefined
  let group: EntryOptions[] = []
  const flush = (): void => {
    if (currentLabel === undefined || group.length === 0) return
    lines.push(`# == ${currentLabel}`)
    lines.push(
      yaml.dump(group, { schema: entryListSchema, noRefs: true }).trimEnd(),
    )
    group = []
  }
  for (let index = 0; index < composed.length; index += 1) {
    const record = provenance[index]
    const row = composed[index]
    if (record === undefined || row === undefined) continue
    const label =
      record.patchedBy.length === 0
        ? record.origin
        : `${record.origin}, patched by ${record.patchedBy.join(', ')}`
    if (label !== currentLabel) {
      flush()
      currentLabel = label
    }
    group.push(row)
  }
  flush()
  return lines.join('\n') + '\n'
}
