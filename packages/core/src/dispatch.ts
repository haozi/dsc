import type { CommandAction } from './commands.ts'
import type { Runtime } from './runtime.ts'

export interface DispatchResult {
  ok: boolean
  action?: CommandAction
  message?: string
}

export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  let tokenStarted = false

  const push = (): void => {
    if (tokenStarted) tokens.push(token)
    token = ''
    tokenStarted = false
  }

  for (const character of input.trim()) {
    if (escaped) {
      token += character
      escaped = false
      tokenStarted = true
    } else if (character === '\\' && quote !== "'") {
      escaped = true
      tokenStarted = true
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
    } else if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
    } else if (/\s/.test(character)) {
      push()
    } else {
      token += character
      tokenStarted = true
    }
  }

  if (escaped) token += '\\'
  if (quote !== undefined) throw new Error(`Unclosed ${quote} quote`)
  push()
  return tokens
}

export async function dispatch(
  context: Runtime,
  input: string | readonly string[],
): Promise<DispatchResult> {
  const transcript = context.require('transcript')

  try {
    const tokens = typeof input === 'string' ? tokenize(input) : [...input]
    if (tokens.length === 0) return { ok: true }

    transcript.append('input', tokens.join(' '))
    const result = await context.require('commands').execute(tokens, context)

    if (result.action === 'clear') transcript.clear()
    if (result.output !== undefined) transcript.append('output', result.output)
    return { ok: true, action: result.action, message: result.output }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    transcript.append('error', message)
    return { ok: false, message }
  }
}
