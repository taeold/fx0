import { verifyArtifactImage } from '../../../lib/artifact-image'
import { readDesignAsset, validChatId } from '../../../lib/chats'
import { assetReference } from '../../../lib/design-artifact'
import { cachedRemoteImage } from '../../../lib/remote-image-cache'

// One image of a design, remote or attached, for the wrapper artifact-frame serves (see lib/artifact-image.ts).
// The design itself never reaches this route: its CSP allows no connections and its
// frame is credentialless.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const session = params.get('session')
  const url = validChatId(session) ? verifyArtifactImage(session, params.get('u'), params.get('sig')) : null
  if (!url) return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } })
  const asset = assetReference(url)
  // Handles are immutable, so the browser may keep an attachment; deleting the chat
  // stops it at the next revalidation.
  const etag = asset ? `"${asset}"` : null
  const cacheHeaders: Record<string, string> = etag
    ? { 'cache-control': 'private, max-age=300', etag }
    : { 'cache-control': 'private, max-age=86400' }
  let image: { bytes: Buffer; mimeType: string } | null
  try {
    if (asset) image = await readDesignAsset(session!, asset.slice('fx0-asset:'.length))
    else {
      const data = await cachedRemoteImage(url)
      image = { bytes: Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'), mimeType: data.slice('data:'.length, data.indexOf(';')) }
    }
  } catch (error) {
    console.error('[fx0] artifact-image:failed', { session, image: asset ? 'asset' : new URL(url).host, reason: (error as Error).message.slice(0, 80) })
    image = null
  }
  if (!image) return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } })
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'content-type': image.mimeType,
      ...cacheHeaders,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}
