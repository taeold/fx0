import { ARTIFACT_IMAGE_PATH, artifactImageSrc } from '../../../lib/artifact-image'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, designFrameCsp, designFrameHtml, prepareDesignArtifactHtml, remoteImagesEnabled } from '../../../lib/design-artifact'
import { markRemoteImages } from '../../../lib/remote-image'
import { readDesignHtml } from '../../../lib/chats'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const session = params.get('session')
  const { html: artifact, past } = await readDesignHtml(session, params.get('revision'))
  const readyToken = crypto.randomUUID()
  // Remote images become markers here; the wrapper loads each from /api/artifact-image
  // and embeds it before the design runs, so the design has no network and the
  // browser keeps the images across revisions (lib/remote-image.ts).
  const marked = artifact != null
    ? markRemoteImages(artifact, crypto.randomUUID().replaceAll('-', ''), { remote: remoteImagesEnabled() })
    : { html: artifact, images: [] }
  const images = marked.images.map(({ marker, url }) => ({ marker, src: artifactImageSrc(session!, url) }))
  const prepared = marked.html == null ? null : prepareDesignArtifactHtml(marked.html, DESIGN_ARTIFACT_EMBEDDED_CSP, readyToken)
  // Every stored design passed validation, so this only guards against one that
  // somehow lacks a doctype: it is never shown without its CSP.
  if (artifact != null && prepared == null) console.error('[fx0] artifact:unrenderable', { session, revision: params.get('revision') })
  const preparedArtifact = prepared ??
    `<!doctype html><html><head><meta charset="utf-8"><title>No design artifact</title></head><body><p>${
      artifact != null ? 'This design could not be prepared for preview.'
        : past ? 'This version is not in the history.' : 'No design artifact has been published for this session.'
    }</p></body></html>`
  const html = designFrameHtml(preparedArtifact, readyToken, images)
  return new Response(html, {
    status: artifact == null ? 404 : 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-security-policy': designFrameCsp(images.length ? `${new URL(request.url).origin}${ARTIFACT_IMAGE_PATH}` : undefined),
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy':
        'accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}
