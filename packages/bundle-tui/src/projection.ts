/**
 * Wire one Agent's durable session events and live assistant stream into the
 * transcript store. Text and thinking stream live; the committed
 * `assistant/message` freezes them to the durable content so the transcript
 * never keeps text the log does not contain.
 * @module @dsc/bundle-tui/projection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TranscriptStore } from './store.ts'

/** The subset of a harness Agent the projection identifies events by. */
export interface ProjectedAgent {
  readonly session: object
}

type Block = { type: string; text?: string }

interface SessionEvent {
  type: string
  surfaceOp?: unknown
  data?: unknown
}

interface StreamPayload {
  agent: unknown
  frame: { type: string; chunk?: { type: string; text?: string } }
}

function blockText(content: readonly Block[], type: string): string {
  return content
    .filter((block) => block.type === type && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/**
 * Subscribe the store to the agent's events.
 * @returns a disposer that detaches both subscriptions.
 */
export function attachProjection(
  ctx: Context,
  agent: ProjectedAgent,
  store: TranscriptStore,
): () => void {
  const onEvent = (session: unknown, event: SessionEvent): void => {
    if (session !== agent.session) return
    switch (event.type) {
      case 'turn/start':
        store.setBusy(true)
        return
      case 'step/start':
        store.turnBegin()
        return
      case 'assistant/message': {
        const data = event.data as {
          message: { content: readonly Block[] }
          usage?: {
            inputTokens: number
            outputTokens: number
            cacheReadTokens?: number
            cacheWriteTokens?: number
          }
        }
        store.assistantCommitted(
          blockText(data.message.content, 'text'),
          blockText(data.message.content, 'reasoning'),
          data.usage === undefined
            ? undefined
            : {
                input_tokens: data.usage.inputTokens,
                output_tokens: data.usage.outputTokens,
                cache_read_input_tokens: data.usage.cacheReadTokens ?? 0,
                cache_creation_input_tokens: data.usage.cacheWriteTokens ?? 0,
              },
        )
        return
      }
      case 'tool/call': {
        const data = event.data as {
          callId: string
          name: string
          arguments: string
        }
        store.toolStart(data.callId, data.name, data.arguments)
        return
      }
      case 'tool/result': {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append')
          return
        const data = event.data as {
          message: {
            toolCallId: string
            isError?: boolean
            content: readonly Block[]
          }
          error?: { reason?: string }
        }
        store.toolResult(data.message.toolCallId, {
          isError: data.message.isError === true,
          content:
            blockText(data.message.content, 'text') ||
            (data.error?.reason ?? ''),
        })
        return
      }
      case 'turn/end': {
        const data = event.data as {
          reason: { kind: string; error?: { code: string; message: string } }
        }
        store.turnEnd(data.reason)
        store.setBusy(false)
        return
      }
      default:
        return
    }
  }
  const onStream = (payload: StreamPayload): void => {
    if (payload.agent !== agent) return
    if (payload.frame.type !== 'chunk' || payload.frame.chunk === undefined)
      return
    const chunk = payload.frame.chunk
    if (chunk.type === 'text-delta') store.textDelta(chunk.text ?? '')
    else if (chunk.type === 'reasoning-delta')
      store.thinkingDelta(chunk.text ?? '')
  }
  const offEvents = ctx.on('session/event' as never, onEvent as never)
  const offStream = ctx.on('agent/assistant-stream' as never, onStream as never)
  return () => {
    offEvents()
    offStream()
  }
}
