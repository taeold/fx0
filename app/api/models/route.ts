import { MODEL } from '../../../lib/chats'

// Every chat runs the one model its actor is started with.
export function GET() {
  return Response.json({ models: [MODEL], defaultModel: MODEL, efforts: {}, fast: [], featured: [MODEL] })
}
