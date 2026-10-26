import { assetReference, BLANK_IMAGE, rewriteRemoteImages } from '../../../lib/design-artifact'
import { readDesignAsset, readDesignHtml } from '../../../lib/chats'

const MAX_EXPORT_IMAGE_CHARS = 20 * 1024 * 1024

// A design's own HTML, for copying or saving. It is model-written, so this origin never
// renders it: plain text, an attachment, and a sandboxing policy. Its scripts run only
// inside the preview's sandboxed frame.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const session = params.get('session')
  const { html, past } = await readDesignHtml(session, params.get('revision'))
  if (html == null) {
    return Response.json({ error: past ? 'This version is not in the history.' : 'No design has been published yet.' }, { status: 404 })
  }
  // Attached images exist only in fx0, so the export carries them as data: URLs (within a
  // budget counted per place they appear); remote images stay as their URLs.
  const handles = new Set<string>()
  rewriteRemoteImages(html, (reference) => {
    const asset = assetReference(reference)
    if (asset) handles.add(asset.slice('fx0-asset:'.length))
    return null
  })
  const loaded = new Map<string, string>()
  await Promise.all([...handles].map(async (handle) => {
    const asset = await readDesignAsset(session!, handle).catch(() => null)
    if (asset) loaded.set(handle, `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`)
  }))
  let total = 0
  const exported = handles.size ? rewriteRemoteImages(html, (reference) => {
    const asset = assetReference(reference)
    if (!asset) return null
    const data = loaded.get(asset.slice('fx0-asset:'.length))
    if (!data || total + data.length > MAX_EXPORT_IMAGE_CHARS) return BLANK_IMAGE
    total += data.length
    return data
  }) : html
  // Streamed: embedded images can take it past the buffered response limit.
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(exported)); controller.close() } })
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="design.html"',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}
