/** @jsxRuntime automatic @jsxImportSource react */
/**
 * The React + Ink terminal surface. It projects the transcript store and
 * forwards input; it holds no business state of its own.
 * @module @dsc/bundle-tui/app
 */
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { useState, useSyncExternalStore } from 'react'
import type { Entry, TranscriptStore } from './store.ts'

/** What the app needs from its host. */
export interface AppHost {
  store: TranscriptStore
  /** Submit one input line; resolves when the line was accepted. */
  submit(line: string): Promise<void>
  /** Interrupt the running turn. */
  interrupt(): void
  /** Colors on or off. */
  theme: boolean
}

const PREVIEW = 160

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat
}

function Row({ entry, theme }: { entry: Entry; theme: boolean }) {
  const color = (name: string): string | undefined => (theme ? name : undefined)
  switch (entry.kind) {
    case 'user':
      return (
        <Box>
          <Text color={color('cyan')} bold>
            {'> '}
          </Text>
          <Text color={color('cyan')}>{entry.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box flexDirection="column">
          <Text>{entry.text}</Text>
        </Box>
      )
    case 'thinking':
      return (
        <Box>
          <Text dimColor italic>
            {preview(entry.text)}
          </Text>
        </Box>
      )
    case 'tool': {
      const status =
        entry.result === undefined ? '…' : entry.result.isError ? '✗' : '✓'
      const statusColor =
        entry.result === undefined
          ? 'yellow'
          : entry.result.isError
            ? 'red'
            : 'green'
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color(statusColor)}>{status} </Text>
            <Text color={color('magenta')} bold>
              {entry.name}
            </Text>
            <Text dimColor> {preview(entry.input)}</Text>
          </Box>
          {entry.result !== undefined && entry.result.content !== '' ? (
            <Box paddingLeft={2}>
              <Text dimColor>{preview(entry.result.content)}</Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    case 'notice':
      return (
        <Box>
          <Text dimColor>· {entry.text}</Text>
        </Box>
      )
    case 'error':
      return (
        <Box>
          <Text color={color('red')}>! {entry.text}</Text>
        </Box>
      )
    case 'command':
      return (
        <Box flexDirection="column">
          <Text dimColor>{entry.text}</Text>
        </Box>
      )
  }
}

function ApprovalPrompt({ host }: { host: AppHost }) {
  const snapshot = useSyncExternalStore(
    host.store.subscribe,
    host.store.getSnapshot,
  )
  const approval = snapshot.approval
  useInput(
    (input) => {
      if (approval === undefined) return
      if (input === 'y' || input === 'Y') approval.answer(true)
      if (input === 'n' || input === 'N') approval.answer(false)
    },
    { isActive: approval !== undefined },
  )
  if (approval === undefined) return null
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text color="yellow" bold>
        approval needed: {approval.toolName}
      </Text>
      {approval.reason !== undefined ? <Text>{approval.reason}</Text> : null}
      <Text dimColor>[y] allow once · [n] reject</Text>
    </Box>
  )
}

export function App({ host }: { host: AppHost }) {
  const snapshot = useSyncExternalStore(
    host.store.subscribe,
    host.store.getSnapshot,
  )
  const [value, setValue] = useState('')
  const theme = host.theme
  const color = (name: string): string | undefined => (theme ? name : undefined)

  useInput(
    (_input, key) => {
      if (key.escape && snapshot.busy) host.interrupt()
    },
    { isActive: snapshot.approval === undefined },
  )

  const submit = async (line: string): Promise<void> => {
    if (line.trim() === '') return
    setValue('')
    await host.submit(line)
  }

  const usage = snapshot.usage
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={color('green')}>
          dsc
        </Text>
        <Text dimColor>
          {snapshot.provider} / {snapshot.model} · {snapshot.permission}
        </Text>
      </Box>
      <Text dimColor>
        {snapshot.cwd} · /help for commands · Esc interrupts · /exit quits
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {snapshot.entries.map((entry) => (
          <Row key={entry.seq} entry={entry} theme={theme} />
        ))}
      </Box>
      <ApprovalPrompt host={host} />
      <Box marginTop={1}>
        <Text color={color(snapshot.busy ? 'yellow' : 'green')}>
          {snapshot.busy ? '… ' : '› '}
        </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(line) => void submit(line)}
          placeholder={
            snapshot.busy
              ? 'running — type to queue, Esc to interrupt'
              : 'prompt or /command'
          }
          focus={snapshot.approval === undefined}
        />
      </Box>
      <Text dimColor>
        {`in ${usage.input_tokens} · out ${usage.output_tokens} · cache ${usage.cache_read_input_tokens} · requests ${snapshot.turns} · tools ${snapshot.toolCalls} · ${snapshot.sessionId}`}
      </Text>
    </Box>
  )
}
