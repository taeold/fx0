import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chatFetch, chatItems, rememberTitle, validChatId } from '../../../lib/chats'
import { parseDesignMdRequest, type DesignMdInput } from '../../../lib/design-md'
import { sseResponse } from '../../../lib/sse'
import { validatePromptImages, validatePromptPreviews } from '../../../lib/prompt-images'
import { PROMPT_TEXT_LIMIT_ERROR, PROMPT_TEXT_MAX_BYTES, promptTextBytes } from '../../../lib/prompt-limits'

// Catalog files ship with this route (outputFileTracingIncludes in next.config.mjs).
async function catalogDesignMd(id: string, name: string): Promise<DesignMdInput> {
  const text = await readFile(path.join(process.cwd(), 'lib', 'design-md', `${id}.md`), 'utf8')
  return { name, source: `getdesign:${id}`, text }
}

// A message sent while a turn runs steers that turn, as in fx0.
export async function POST(request: Request) {
  const requested = new URL(request.url).searchParams.get('session')
  const created = requested === 'new'
  const id = created ? crypto.randomUUID() : requested
  if (!validChatId(id)) return Response.json({ error: 'Session not found' }, { status: 404 })

  let body: { text?: unknown; clientId?: unknown; afterSeq?: unknown; images?: unknown; previews?: unknown; designMd?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const checkedImages = validatePromptImages(body?.images)
  if ('error' in checkedImages) return Response.json({ error: checkedImages.error }, { status: 413 })
  const images = checkedImages.images
  if (!text && !images.length) return Response.json({ error: 'empty prompt' }, { status: 400 })
  // Rejected whole, never cut: the composer keeps the draft and shows this error.
  if (promptTextBytes(text) > PROMPT_TEXT_MAX_BYTES) return Response.json({ error: PROMPT_TEXT_LIMIT_ERROR }, { status: 413 })
  // Thumbnails kept with the message so a reload still shows the images.
  const previews = validatePromptPreviews(body?.previews, images.length)
  const designRequest = parseDesignMdRequest(body?.designMd)
  if (designRequest && 'error' in designRequest) return Response.json({ error: designRequest.error }, { status: 400 })
  const designMd = !designRequest ? undefined : 'option' in designRequest
    ? await catalogDesignMd(designRequest.option.id, designRequest.option.name)
    : designRequest.upload
  // The client's id names the message in the chat's log, so it must be one libfx accepts.
  const clientId = typeof body?.clientId === 'string' && /^[0-9a-z-]{1,40}$/.test(body.clientId) ? body.clientId : `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const afterSeq = typeof body.afterSeq === 'number' && Number.isSafeInteger(body.afterSeq) && body.afterSeq >= 0 ? body.afterSeq : 0

  const steered = await chatFetch(id, '/steer', {
    method: 'POST',
    body: JSON.stringify({ text, clientId, images, previews, designMd }),
  }, { create: true })
  if (!steered.ok) return Response.json({ error: `the chat refused the message: ${await steered.text()}` }, { status: 502 })
  rememberTitle(id, text)

  // The stream ends with the turn the message started, or the one it joined.
  let messageId: number | undefined
  let turnId: number | undefined
  return sseResponse((signal) => chatItems(id, { follow: true, signal }), {
    after: afterSeq,
    headers: created ? { 'x-fx0-session': id } : {},
    closeWhen(item) {
      if (item.type === 'user' && item.clientId === clientId) messageId = item.id
      if (item.type === 'turn_start' && item.id === messageId) turnId = messageId
      if (item.type === 'status' && item.id === messageId && item.turnId != null) turnId = item.turnId
      return (item.type === 'done' || item.type === 'error') && turnId != null && item.id === turnId
    },
  })
}
