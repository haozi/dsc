import {
  dispatch,
  type Runtime,
  type TranscriptEvent,
} from '@tiny-harness/core'
import { Box, render, Text } from 'ink'
import TextInput from 'ink-text-input'
import { useState, useSyncExternalStore } from 'react'

interface AppProps {
  runtime: Runtime
  onExit(): void
}

const colors: Record<TranscriptEvent['kind'], string> = {
  input: 'cyan',
  output: 'white',
  error: 'red',
}

function TranscriptRow({ event }: { event: TranscriptEvent }) {
  let marker = '·'
  if (event.kind === 'input') marker = '>'
  if (event.kind === 'error') marker = '!'
  return (
    <Box>
      <Text color={colors[event.kind]}>{marker} </Text>
      <Text color={colors[event.kind]}>{event.text}</Text>
    </Box>
  )
}

function App({ runtime, onExit }: AppProps) {
  const transcript = runtime.require('transcript')
  const events = useSyncExternalStore(
    transcript.subscribe,
    transcript.getSnapshot,
  )
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (input: string): Promise<void> => {
    if (busy || input.trim() === '') return
    setValue('')
    setBusy(true)
    const result = await dispatch(runtime, input)
    setBusy(false)
    if (result.action === 'exit') onExit()
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="green">
          tiny
        </Text>
        <Text dimColor>default profile</Text>
      </Box>
      <Text dimColor>React CLI runtime · type help to inspect commands</Text>
      <Box flexDirection="column" marginTop={1}>
        {events.map((event) => (
          <TranscriptRow key={event.seq} event={event} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="green">{busy ? '… ' : '› '}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(input) => void submit(input)}
          placeholder={busy ? 'running' : 'enter a command'}
        />
      </Box>
    </Box>
  )
}

export async function runTui(runtime: Runtime): Promise<void> {
  let unmount = (): void => {}
  const instance = render(<App runtime={runtime} onExit={() => unmount()} />)
  unmount = instance.unmount
  await instance.waitUntilExit()
}
