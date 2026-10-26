import { chatFetch, validChatId } from '../../../lib/chats'

export async function POST(request: Request) {
  const id = new URL(request.url).searchParams.get('session')
  if (!validChatId(id)) return Response.json({ error: 'Session not found' }, { status: 404 })
  const response = await chatFetch(id, '/cancel', { method: 'POST' })
  return Response.json(await response.json(), { status: response.status })
}
