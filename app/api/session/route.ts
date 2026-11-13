import { chatExists, deleteChat, readChat, validChatId } from '../../../lib/chats'

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('session')
  if (!validChatId(id) || !(await chatExists(id))) return Response.json({ error: 'Session not found' }, { status: 404 })
  return Response.json(await readChat(id))
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get('session')
  if (!validChatId(id)) return Response.json({ error: 'Session not found' }, { status: 404 })
  await deleteChat(id)
  return Response.json({ ok: true })
}
