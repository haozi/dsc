#!/usr/bin/env -S npx tsx

import manifest from '../package.json' with { type: 'json' }
import { help, parseArgs } from './args.ts'

let invocation
try {
  invocation = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(
    `tiny: ${error instanceof Error ? error.message : String(error)}`,
  )
  console.error('Run "tiny --help" for usage.')
  process.exit(1)
}

if (invocation.mode === 'help') {
  console.log(help)
  process.exit(0)
}

if (invocation.mode === 'version') {
  console.log(manifest.version)
  process.exit(0)
}

const { boot } = await import('./boot.ts')
const runtime = await boot()

try {
  if (invocation.mode === 'run') {
    const { runHeadless } = await import('./surfaces/headless.ts')
    process.exitCode = await runHeadless(runtime, invocation.tokens)
  } else {
    const { runTui } = await import('./surfaces/tui.tsx')
    await runTui(runtime)
  }
} finally {
  await runtime.dispose()
}
