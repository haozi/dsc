import { initProfile, resolveProfileDir } from '@dsc/core'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  diagnose,
  exitCodeOf,
  renderDoctorJson,
  renderDoctorText,
} from '../src/doctor.ts'

let home: string
const savedHome = process.env.DSC_HOME
const savedKey = process.env.DEEPSEEK_API_KEY

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsc-doctor-'))
  process.env.DSC_HOME = home
  delete process.env.DEEPSEEK_API_KEY
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = savedHome
  if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey
  rmSync(home, { recursive: true, force: true })
})

const byName = (report: Awaited<ReturnType<typeof diagnose>>, name: string) =>
  report.checks.find((row) => row.name === name)

describe('diagnose', () => {
  test('reports the runtime, bundles, and an empty home', async () => {
    const report = await diagnose()
    expect(byName(report, 'node')?.status).toBe('ok')
    expect(byName(report, 'module_loader')?.status).toBe('ok')
    expect(byName(report, 'bundle:@deepseek-ai/dsh-base')).toMatchObject({
      status: 'ok',
      version: expect.stringMatching(/^\d/),
    })
    expect(byName(report, 'bundle:@dsc/bundle-tui')?.status).toBe('ok')
    expect(byName(report, 'ripgrep')?.status).toBe('ok')
    expect(byName(report, 'credentials')?.status).toBe('warn')
    expect(report.checks.some((row) => row.name.startsWith('profile:'))).toBe(
      false,
    )
    expect(exitCodeOf(report, false)).toBe(0)
    expect(exitCodeOf(report, true)).toBe(1)
  })

  test('fails on a profile that cannot compose and renders both formats', async () => {
    initProfile(resolveProfileDir('broken', home), ['@nope/missing'])
    initProfile(resolveProfileDir('fine', home), ['@deepseek-ai/dsh-base'])
    process.env.DEEPSEEK_API_KEY = 'x'
    const report = await diagnose()
    expect(byName(report, 'profile:broken')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining(
        'cannot resolve profile bundle "@nope/missing"',
      ),
    })
    expect(byName(report, 'profile:fine')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('@deepseek-ai/dsh-base@'),
    })
    expect(byName(report, 'credentials')?.source).toBe('env')
    expect(exitCodeOf(report, false)).toBe(1)
    const text = renderDoctorText(report)
    expect(text).toContain('FAIL  profile:broken')
    expect(JSON.parse(renderDoctorJson(report)).checks.length).toBe(
      report.checks.length,
    )
  })

  test('warns on a world-readable credential store', async () => {
    writeFileSync(join(home, '.credentials.yaml'), 'x: y\n')
    chmodSync(join(home, '.credentials.yaml'), 0o644)
    const report = await diagnose()
    expect(byName(report, 'credentials')?.status).toBe(
      process.platform === 'win32' ? 'ok' : 'warn',
    )
  })
})
