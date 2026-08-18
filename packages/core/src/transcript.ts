export type TranscriptEventKind = 'input' | 'output' | 'error'

export interface TranscriptEvent {
  seq: number
  kind: TranscriptEventKind
  text: string
}

export type TranscriptLogEvent =
  TranscriptEvent | { seq: number; kind: 'clear' }

export class Transcript {
  readonly #listeners = new Set<() => void>()
  #events: readonly TranscriptLogEvent[] = []
  #snapshot: readonly TranscriptEvent[] = []
  #nextSeq = 1

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): readonly TranscriptEvent[] => this.#snapshot

  getEvents(): readonly TranscriptLogEvent[] {
    return this.#events
  }

  append(kind: TranscriptEventKind, text: string): TranscriptEvent {
    const event = { seq: this.#nextSeq++, kind, text }
    this.#events = [...this.#events, event]
    this.#snapshot = [...this.#snapshot, event]
    this.#emit()
    return event
  }

  clear(): void {
    this.#events = [...this.#events, { seq: this.#nextSeq++, kind: 'clear' }]
    this.#snapshot = []
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}
