import { chatExists, chatItems, validChatId } from '../../../lib/chats'
import { sseResponse } from '../../../lib/sse'

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('session')
  if (!validChatId(id) || !(await chatExists(id))) return Response.json({ error: 'Session not found' }, { status: 404 })
  const after = Number(new URL(request.url).searchParams.get('after') ?? 0)
  const lastEventId = Number(request.headers.get('last-event-id') ?? 0)
  return sseResponse((signal) => chatItems(id, { follow: true, signal }), {
    after: Math.max(Number.isFinite(after) ? after : 0, Number.isFinite(lastEventId) ? lastEventId : 0),
  })
}
