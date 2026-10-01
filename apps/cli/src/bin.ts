#!/usr/bin/env -S npx tsx
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../package.json', import.meta.url)),
    'utf8',
  ),
) as { version?: string }

process.stdout.write(`dsc ${manifest.version ?? '0.0.0'}\n`)
