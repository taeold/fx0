import { MODEL } from '../../../lib/chats'

export function GET() {
  return Response.json({ model: MODEL, effort: '', fast: false })
}

export function POST() {
  return Response.json({ ok: true, model: MODEL, effort: '', fast: false })
}
