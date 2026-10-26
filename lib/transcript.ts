// A transcript snapshot: the client reducer replayed over a chat's items.
// @ts-expect-error Node strip-types tests require the source extension.
import { replayEvents, type ReplayedChatState } from '../components/chat-state.ts'
import type { SessionInfo, SessionView, StreamItem } from './events'

export interface TranscriptSnapshot extends Omit<ReplayedChatState, 'startedTurns'> {
  version: 1
  startedTurns: number[]
}

export interface SessionSnapshot {
  transcript: TranscriptSnapshot
  summary: SessionInfo | null
}

export function transcriptState(snapshot: TranscriptSnapshot): ReplayedChatState {
  const { version: _version, startedTurns, ...state } = snapshot
  return { ...state, startedTurns: new Set(startedTurns) }
}

export function compactTranscript(events: StreamItem[], view: SessionView, previous?: TranscriptSnapshot | null): TranscriptSnapshot {
  const state = replayEvents(events, view, previous ? transcriptState(previous) : undefined)
  return { ...state, version: 1, startedTurns: [...state.startedTurns] }
}
