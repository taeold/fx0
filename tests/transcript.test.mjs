import assert from 'node:assert/strict'
import test from 'node:test'
import { compactTranscript, transcriptState } from '../lib/transcript.ts'
import { replayEvents, shouldAcceptSessionEvent } from '../components/chat-state.ts'

const view = { artifactRevision: 0 }
const events = [
  { type: 'user', id: 1, seq: 1, text: 'Design', imagePreviews: ['data:image/jpeg;base64,AA=='], designMd: { name: 'Apple' } },
  { type: 'turn_start', id: 1, turnId: 1, seq: 2, at: 10 },
  { type: 'tool_start', turnId: 1, seq: 3, callId: 4, name: 'design', at: 11 },
  { type: 'text', turnId: 1, seq: 4, delta: 'Hello' },
  { type: 'text', turnId: 1, seq: 5, delta: ' world' },
  { type: 'tool_end', turnId: 1, seq: 6, callId: 4, content: 'done', at: 20 },
  { type: 'question', turnId: 1, seq: 7, qid: 1, questions: [{ question: 'Color?', options: [] }] },
  { type: 'question_resolved', turnId: 1, seq: 8, qid: 1, answers: { 'Color?': 'Blue' } },
  { type: 'artifact', turnId: 1, seq: 9, artifactRevision: 3 },
  { type: 'done', id: 1, turnId: 1, seq: 10 },
]

test('every checkpoint boundary replays exactly like the full journal', () => {
  for (let split = 0; split <= events.length; split++) {
    const checkpoint = compactTranscript(events.slice(0, split), view)
    // A browser round trip loses Sets; the checkpoint must remain serializable.
    const decoded = JSON.parse(JSON.stringify(checkpoint))
    const wire = (value) => JSON.parse(JSON.stringify(value, (_, field) => field instanceof Set ? [...field] : field))
    assert.deepEqual(wire(transcriptState(compactTranscript(events.slice(split), view, decoded))), wire(replayEvents(events, view)))
  }
})

test('restarting a turn clears its old entries even across a checkpoint', () => {
  const previous = compactTranscript(events.slice(0, 5), view)
  const tail = [{ type: 'turn_start', id: 1, turnId: 1, seq: 11 }, { type: 'text', turnId: 1, delta: 'Recovered', seq: 12 }]
  assert.deepEqual(transcriptState(compactTranscript(tail, view, previous)), replayEvents([...events.slice(0, 5), ...tail], view))
})

test('text deltas preserve mounted message keys and old events cannot duplicate a snapshot', () => {
  const previous = compactTranscript(events.slice(0, 4), view)
  const updated = compactTranscript(events.slice(3, 5), view, previous)
  assert.equal(updated.entries.at(-1).key, previous.entries.at(-1).key)
  assert.equal(updated.entries.at(-1).text, 'Hello world')
  const seen = new Set()
  assert.equal(shouldAcceptSessionEvent('chat', 'chat', events[3], seen, 5), false)
  assert.equal(seen.size, 0)
  assert.equal(shouldAcceptSessionEvent('chat', 'chat', events[5], seen, 5), true)
})

test('a long response compacts thousands of deltas into one message', () => {
  const journal = [{ type: 'turn_start', seq: 1, id: 1, turnId: 1 },
    ...Array.from({ length: 10000 }, (_, i) => ({ type: 'text', seq: i + 2, turnId: 1, delta: 'x' }))]
  const snapshot = compactTranscript(journal, view)
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].text.length, 10000)
  assert.ok(JSON.stringify(snapshot).length < JSON.stringify(journal).length / 20)
})
