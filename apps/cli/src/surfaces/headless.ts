import { dispatch, type Runtime } from '@tiny-harness/core'

export async function runHeadless(
  runtime: Runtime,
  tokens: readonly string[],
): Promise<number> {
  const result = await dispatch(runtime, tokens)
  if (result.message !== undefined) {
    const stream = result.ok ? process.stdout : process.stderr
    stream.write(`${result.message}\n`)
  }
  return result.ok ? 0 : 1
}
