import { describe, expect, test } from 'vitest'
import {
  buildIdentity,
  renderVersionJson,
  renderVersionText,
} from '../src/version.ts'

describe('buildIdentity', () => {
  test('reports the runtime, home, profiles and resolved runtime assets', () => {
    const identity = buildIdentity()
    expect(identity.name).toBe('dsc')
    expect(identity.node).toBe(process.version)
    expect(identity.profiles.tui).toContain('@deepseek-ai/dsh-base')
    const base = identity.runtime_assets.find(
      (asset) => asset.name === '@deepseek-ai/dsh-base',
    )
    expect(base?.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(base?.declared).not.toBe('(transitive)')
    const cordis = identity.runtime_assets.find(
      (asset) => asset.name === '@deepseek-ai/cordis',
    )
    expect(cordis?.version).toMatch(/^4\./)
  })

  test('renders text and JSON', () => {
    const identity = buildIdentity()
    const text = renderVersionText(identity)
    expect(text.split('\n')[0]).toBe(`dsc ${identity.version}`)
    expect(text).toContain('@deepseek-ai/dsh-base')
    expect(JSON.parse(renderVersionJson(identity))).toMatchObject({
      name: 'dsc',
    })
  })
})
