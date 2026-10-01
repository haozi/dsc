#!/usr/bin/env -S npx tsx
/**
 * dsc — command-line entry. Dynamic imports per mode keep unrelated modes
 * out of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * A labelled launcher error (`dsc: ...`) prints as one line; set `DSC_DEBUG`
 * for the stack.
 * @module @dsc/cli/bin
 */
import { bridgeDshHome, loadLayeredEnv } from '@dsc/core'
import { parseDscArgs } from './args.ts'
import { NAME, readVersion } from './install.ts'

const invocation = parseDscArgs(process.argv.slice(2), readVersion())
bridgeDshHome()

try {
  switch (invocation.mode) {
    case 'version': {
      const { buildIdentity, renderVersionJson, renderVersionText } =
        await import('./version.ts')
      const identity = buildIdentity()
      process.stdout.write(
        invocation.json
          ? renderVersionJson(identity)
          : renderVersionText(identity),
      )
      break
    }
    case 'doctor': {
      const { diagnose, exitCodeOf, renderDoctorJson, renderDoctorText } =
        await import('./doctor.ts')
      const report = await diagnose()
      process.stdout.write(
        invocation.json ? renderDoctorJson(report) : renderDoctorText(report),
      )
      process.exitCode = exitCodeOf(report, invocation.strict)
      break
    }
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      await runProfile({
        environment: loadLayeredEnv(NAME),
        profile: invocation.profile,
        patchFiles: invocation.patches,
        args: invocation.args,
      })
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
      )
      break
    }
    default:
      throw new Error(
        `${NAME}: unhandled invocation mode ${JSON.stringify(invocation)}`,
      )
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (process.env.DSC_DEBUG !== undefined || !message.startsWith(`${NAME}:`))
    throw error
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
