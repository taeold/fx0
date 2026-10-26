// fx0's UI renders the StreamItems that fx0 main's Redis projector (lib/projector.ts) wrote.
// Here the app reads the chat's libfx log from its actor instead, so this converts it on read.
import type { FxStreamLine } from 'libfx'
import type { StreamItem } from './events'

// A chat's libfx log, read from its first line, as the StreamItems fx0's UI renders.
// fx0 numbers messages and the turns they start; libfx names them by the client's
// id. Numbering in log order gives every reader the same numbers and the same seq.
//
// A prompt with images also carries its image count and thumbnails, which the chat's
// actor adds to the turn_start line.
type Line = FxStreamLine & { input?: string; imageCount?: number; imagePreviews?: string[] }

const DESIGN_TOOLS = new Set(['publish_design', 'edit_design'])
const MAX_TOOL_OUTPUT = 32 * 1024

// The client's message id starts with the time it was sent, in base 36.
function sentAt(messageId: string): number | undefined {
  const at = parseInt(messageId.split('-')[0], 36)
  return at > Date.UTC(2020, 0) && at < Date.UTC(2100, 0) ? at : undefined
}

function toolLabel(line: Extract<FxStreamLine, { type: 'tool_start' }>): string | undefined {
  const input = line.input as Record<string, unknown> | undefined
  if (line.name === 'publish_design') {
    const html = typeof input?.html === 'string' ? input.html : null
    return html == null ? 'complete HTML document' : `complete HTML document (${Buffer.byteLength(html, 'utf8')} bytes)`
  }
  if (input && typeof input === 'object') {
    const label = typeof input.url === 'string' ? input.url : JSON.stringify(input)
    return label.length > 120 ? label.slice(0, 120) + '…' : label
  }
  if (line.inputTruncated) return line.inputPreview.slice(0, 300) + '…'
  return undefined
}

function revisionOf(content: string | undefined): number | null {
  try {
    const result = JSON.parse(content ?? '') as { ok?: boolean; revision?: number }
    return result.ok === true && typeof result.revision === 'number' ? result.revision : null
  } catch {
    return null
  }
}

export function createConverter(): (line: Line) => StreamItem[] {
  let seq = 0
  let epoch = 0
  const messages = new Map<string, number>()
  const calls = new Map<string, number>()

  const message = (id: string): { id: number; isNew: boolean } => {
    const known = messages.get(id)
    if (known != null) return { id: known, isNew: false }
    messages.set(id, messages.size + 1)
    return { id: messages.size, isNew: true }
  }

  const itemsOf = (line: Line): Omit<StreamItem, 'seq'>[] => {
    if (line.type === 'idle') return []
    const turnId = messages.get(line.messageId)
    switch (line.type) {
      case 'turn_start': {
        const { id, isNew } = message(line.messageId)
        const at = sentAt(line.messageId)
        const user: Omit<StreamItem, 'seq'> = {
          type: 'user', id, clientId: line.messageId, author: 'You', text: line.input ?? '', at,
          imageCount: line.imageCount, imagePreviews: line.imagePreviews,
        }
        return [...(isNew ? [user] : []), { type: 'turn_start', id, turnId: id, at }]
      }
      case 'turn_resume':
        return [{ type: 'status', id: turnId, turnId, text: 'continuing after an interruption…' }]
      case 'user_message': {
        // A message sent while this turn ran, which the model now sees.
        if (!line.id) return []
        const { id } = message(line.id)
        return [
          {
            type: 'user', id, clientId: line.id, author: 'You', text: line.text, at: sentAt(line.id),
            imageCount: line.imageCount, imagePreviews: line.imagePreviews,
          },
          { type: 'status', id, turnId, text: 'steering the running turn' },
        ]
      }
      case 'text_delta':
        return line.delta ? [{ type: 'text', delta: line.delta, turnId }] : []
      case 'reasoning_delta':
        return line.delta ? [{ type: 'reasoning', delta: line.delta, turnId }] : []
      case 'tool_start':
        calls.set(line.id, calls.size + 1)
        return [{ type: 'tool_start', name: line.name, command: toolLabel(line), callId: calls.get(line.id), turnId }]
      case 'tool_end': {
        const end: Omit<StreamItem, 'seq'> = {
          type: 'tool_end', name: line.name, callId: calls.get(line.id), isError: line.isError, turnId,
          content: line.content && line.content.length > MAX_TOOL_OUTPUT ? `${line.content.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated]` : line.content,
        }
        const revision = DESIGN_TOOLS.has(line.name) && !line.isError ? revisionOf(line.content) : null
        return revision == null ? [end] : [end, { type: 'artifact', artifactRevision: revision, turnId }]
      }
      case 'turn_end': {
        const failed = line.stopReason === 'error' || line.stopReason === 'unknown' || (line.stopReason === 'refused' && line.error?.message)
        return [failed
          ? { type: 'error', id: turnId, turnId, text: line.error?.message || 'This message did not finish. Resend to retry.' }
          : { type: 'done', id: turnId, turnId, stopReason: line.stopReason, usage: line.usage }]
      }
      default:
        return []
    }
  }

  return (line) => {
    // libfx: a line written by a worker with a lower epoch than one before it is stale.
    if (line.epoch != null) {
      if (line.epoch < epoch) return []
      epoch = line.epoch
    }
    return itemsOf(line).map((item) => ({ ...item, seq: ++seq }))
  }
}
