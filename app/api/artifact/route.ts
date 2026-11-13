import { readDesignHtml } from '../../../lib/chats'

// A design's own HTML, for copying or saving. It is model-written, so this origin never
// renders it: plain text, an attachment, and a sandboxing policy. Its scripts run only
// inside the preview's sandboxed frame.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const { html, past } = await readDesignHtml(params.get('session'), params.get('revision'))
  if (html == null) {
    return Response.json({ error: past ? 'This version is not in the history.' : 'No design has been published yet.' }, { status: 404 })
  }
  return new Response(html, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="design.html"',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
}
