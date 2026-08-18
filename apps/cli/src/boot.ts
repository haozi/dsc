import { Runtime } from '@tiny-harness/core'
import { defaultProfile } from './profiles/default.ts'

export async function boot(): Promise<Runtime> {
  const runtime = new Runtime()
  await runtime.mount(defaultProfile)
  return runtime
}
