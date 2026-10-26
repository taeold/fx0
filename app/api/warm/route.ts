import { validChatId, wakeChat } from '../../../lib/chats'

// Called while the user types, so the chat's actor is up by the time the message is sent.
export async function POST(request: Request) {
  const id = new URL(request.url).searchParams.get('session')
  if (validChatId(id)) await wakeChat(id).catch(() => {})
  return new Response(null, { status: 204 })
}
