import { CommandRegistry } from './commands.ts'
import type { Plugin } from './runtime.ts'
import { Transcript } from './transcript.ts'

declare module './runtime.ts' {
  interface ServiceMap {
    commands: CommandRegistry
    transcript: Transcript
  }
}

export const corePlugin: Plugin = {
  name: 'core',
  apply(context) {
    context.effect(() => context.provide('commands', new CommandRegistry()))
    context.effect(() => context.provide('transcript', new Transcript()))
  },
}
