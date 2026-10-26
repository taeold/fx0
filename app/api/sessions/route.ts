import { connection } from 'next/server'
import { listChats } from '../../../lib/chats'

export async function GET() {
  await connection()
  return Response.json({ sessions: await listChats(), nextCursor: null, now: Date.now() })
}

// A new chat is only an id until its first message makes its Drive.
export async function POST() {
  const id = crypto.randomUUID()
  return Response.json({ id, sessionId: id }, { status: 201 })
}
