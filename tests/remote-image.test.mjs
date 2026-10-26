import assert from 'node:assert/strict'
import test from 'node:test'
import https from 'node:https'
import dns from 'node:dns/promises'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'

// lib/remote-image-cache.ts imports without extensions, as Next resolves them.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && !context.parentURL?.includes('/node_modules/')) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})
import { BLANK_IMAGE, DESIGN_ARTIFACT_EMBEDDED_CSP, MAX_DESIGN_ARTIFACT_BYTES, remoteImageUrl, rewriteRemoteImages, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { loadRemoteImage, markRemoteImages, MAX_REMOTE_IMAGES } from '../lib/remote-image.ts'
import { artifactImageSrc, verifyArtifactImage } from '../lib/artifact-image.ts'
import { sniffImageType } from '../lib/image-sniff.ts'
import { MAX_IMAGE_FETCH_BYTES } from '../lib/public-fetch.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`
const doc = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

test('only absolute https URLs without credentials are fetchable', () => {
  assert.equal(remoteImageUrl('https://example.com/a b.png'), 'https://example.com/a%20b.png')
  for (const value of ['http://example.com/a.png', 'https://user:pass@example.com/a.png', '//example.com/a.png', 'https://', `https://example.com/${'a'.repeat(2048)}`]) {
    assert.equal(remoteImageUrl(value), null, value)
  }
})

test('image types come from the bytes', () => {
  assert.equal(sniffImageType(PNG), 'image/png')
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])), 'image/jpeg')
  assert.equal(sniffImageType(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1')), 'image/gif')
  assert.equal(sniffImageType(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp')
  assert.equal(sniffImageType(Buffer.from('\x00\x00\x00\x1cftypmif1\x00\x00\x00\x00mif1avif', 'latin1')), 'image/avif')
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>')), null)
  assert.equal(sniffImageType(PNG.subarray(0, 8)), null)
})

test('preparation embeds remote images in every accepted place and nothing else', () => {
  const source = doc(
    '<img src="https://example.com/a.png?x=1&amp;y=2" alt="">' +
    "<img src='https://example.com/b.png'>" +
    '<img src=https://example.com/c.png>' +
    '<img srcset="https://cdn.example.com/w_1,h_1/small.png 1x, https://example.com/large.png 2x">' +
    '<picture><source srcset="https://example.com/a.webp"></picture>' +
    '<video poster="https://example.com/p.png"></video>' +
    '<svg><image href="https://example.com/s.png"/><image xlink:href="https://example.com/t.png"/></svg>' +
    '<div style="background-image: url(&quot;https://example.com/bg.png&quot;); color: red"></div>' +
    "<div style=\"background: url('https://example.com/bg2.png') no-repeat, url(https://example.com/bg3.png)\"></div>" +
    '<p>https://example.com/text.png url(https://example.com/text2.png)</p>' +
    '<a href="https://example.com/page">link</a>' +
    '<script>const u = "https://example.com/script.png"; const c = "url(https://example.com/script2.png)"</script>' +
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">',
    '<style>.a { background: url(https://example.com/style.png) } /* url(https://example.com/comment.png) */ ' +
    '.b::after { content: "url(https://example.com/string.png)" } .c { background: url("https://example.com/quoted.png") } ' +
    '.d { background: url(https://example.com/esc\\61 pe.png) } .e { background: url(http://example.com/plain.png) }</style>',
  )
  assert.equal(validateDesignArtifactHtml(source).ok, true)
  const embedded = []
  const out = rewriteRemoteImages(source, (url) => { embedded.push(url); return PNG_URL })
  assert.deepEqual(embedded.sort(), [
    'https://example.com/a.png?x=1&y=2', 'https://example.com/b.png', 'https://example.com/c.png', 'https://example.com/large.png',
    'https://example.com/a.webp', 'https://example.com/p.png', 'https://example.com/s.png', 'https://example.com/t.png',
    'https://example.com/bg.png', 'https://example.com/bg2.png', 'https://example.com/bg3.png', 'https://example.com/style.png',
    'https://example.com/quoted.png',
  ].sort(), 'a srcset embeds only its largest candidate')
  for (const untouched of ['https://example.com/text.png', 'url(https://example.com/text2.png)', 'href="https://example.com/page"',
    '"https://example.com/script.png"', 'url(https://example.com/script2.png)', 'url(https://example.com/comment.png)',
    '"url(https://example.com/string.png)"', 'url(https://example.com/esc\\61 pe.png)', 'url(http://example.com/plain.png)',
    'src="data:image/gif;base64,R0lGODlhAQABAAAAACw="']) {
    assert.ok(out.includes(untouched), untouched)
  }
  assert.ok(!out.includes('small.png'), 'the smaller srcset candidate is dropped')
  assert.ok(out.includes(`srcset="${PNG_URL}"`))
  assert.ok(out.includes(`background-image: url(${PNG_URL}); color: red`))
  assert.ok(out.includes(`.a { background: url(${PNG_URL}) }`))
})

test('anything but a base64 data: image becomes a blank image, so nothing can break out', () => {
  for (const value of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', `${PNG_URL}"><script>`, 'data:image/png;base64,a b']) {
    const out = rewriteRemoteImages(doc('<img src="https://example.com/a.png">', '<style>.a{background:url(https://example.com/b.png)}</style>'), () => value)
    assert.ok(out.includes(`<img src="${BLANK_IMAGE}">`), value)
    assert.ok(out.includes(`url(${BLANK_IMAGE})`), value)
  }
})

const NONCE = '0123456789abcdef0123456789abcdef'

test('marking names each image once, in document order, up to the count budget', () => {
  const urls = Array.from({ length: MAX_REMOTE_IMAGES + 2 }, (_, index) => `https://example.com/${index}.png`)
  const html = doc(urls.map((url) => `<img src="${url}">`).join('') + `<div style="background:url(${urls[0]})"></div>`)
  const result = markRemoteImages(html, NONCE)
  assert.deepEqual(result.images.map(({ url }) => url), urls.slice(0, MAX_REMOTE_IMAGES))
  assert.deepEqual(result.images[0], { marker: `fx0-image-${NONCE}-0`, url: urls[0] })
  assert.equal(result.html.split(`fx0-image-${NONCE}-0`).length - 1, 2, 'every place an image appears carries its marker')
  assert.equal(result.html.split(BLANK_IMAGE).length - 1, 2, 'images past the count budget are blank')
  assert.ok(!result.html.includes('https://'))
  const plain = doc('<p>no images</p>')
  assert.deepEqual(markRemoteImages(plain, NONCE), { html: plain, images: [] })
})

test('a design cannot forge a marker: only the ones fx0 writes, with this response\'s nonce, survive', () => {
  const out = rewriteRemoteImages(doc('<img src="https://example.com/a.png">'), () => 'fx0-image-zz-0')
  assert.ok(out.includes(`<img src="${BLANK_IMAGE}">`))
  const typed = doc(`<p>fx0-image-${NONCE}-0</p><img src="https://example.com/a.png">`)
  const marked = markRemoteImages(typed, 'ffffffffffffffffffffffffffffffff')
  assert.ok(marked.html.includes(`<p>fx0-image-${NONCE}-0</p>`), 'text that looks like another nonce is not this response\'s marker')
})

test('an image URL is signed for one chat: another chat, URL or signature is refused', () => {
  process.env.SESSION_SECRET ??= 'deterministic-artifact-image-test-secret-32+'
  const chat = '11111111-1111-4111-8111-111111111111'
  const url = 'https://images.example.com/a.png?w=100&h=50'
  const src = new URL(artifactImageSrc(chat, url), 'https://fx0.example')
  assert.equal(src.pathname, '/api/artifact-image')
  assert.equal(src.searchParams.get('session'), chat)
  assert.equal(artifactImageSrc(chat, url), artifactImageSrc(chat, url), 'stable, so the browser keeps it across revisions')
  const sig = src.searchParams.get('sig')
  assert.equal(verifyArtifactImage(chat, url, sig), url)
  assert.equal(verifyArtifactImage('22222222-2222-4222-8222-222222222222', url, sig), null)
  assert.equal(verifyArtifactImage(chat, 'https://images.example.com/b.png', sig), null)
  assert.equal(verifyArtifactImage(chat, url, `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`), null)
  assert.equal(verifyArtifactImage(chat, url, null), null)
  assert.equal(verifyArtifactImage(chat, 'http://images.example.com/a.png', sig), null)
})

test('preparing a design stays linear in its size, however its CSS is shaped', () => {
  const fill = (unit) => unit.repeat(Math.floor((MAX_DESIGN_ARTIFACT_BYTES - 200) / unit.length))
  for (const [name, html] of [
    ['many style attributes', doc(fill('<b style="a">x</b>'))],
    ['unclosed url( in style attributes', doc(fill('<b style="url(">'))],
    ['unclosed url( in a style block', doc('', `<style>${fill('url(')}</style>`)],
    ['unclosed quoted url( in a style block', doc('', `<style>${fill('url("')}</style>`)],
  ]) {
    assert.equal(validateDesignArtifactHtml(html).ok, true, name)
    const started = performance.now()
    rewriteRemoteImages(html, () => PNG_URL)
    assert.ok(performance.now() - started < 500, `${name}: ${Math.round(performance.now() - started)} ms`)
  }
})

test('embedded designs need no network: the CSP stays data-only', () => {
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /img-src data:;/)
  assert.doesNotMatch(DESIGN_ARTIFACT_EMBEDDED_CSP, /https?:/)
})

// The upstream: DNS and https.request are faked, the way tests/public-fetch.test.mjs does.
const PUBLIC_IP = '93.184.216.34'
function upstream(t, replies, address = PUBLIC_IP) {
  const requests = []
  t.mock.method(dns, 'lookup', async () => [{ address, family: 4 }])
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => queueMicrotask(() => {
      const reply = replies.shift()
      const response = Readable.from(reply.chunks, { objectMode: false })
      Object.assign(response, { statusCode: reply.statusCode, headers: reply.headers ?? {} })
      callback(response)
    })
    requests.push({ url: url.href, options })
    return request
  })
  return requests
}

test('a remote image loads as a data: URL typed by its bytes, without cookies or referrer', async (t) => {
  const requests = upstream(t, [{ statusCode: 200, headers: { 'content-type': 'text/html' }, chunks: [PNG] }])
  assert.equal(await loadRemoteImage('https://images.example.com/a.png'), PNG_URL)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example.com/a.png')
  assert.equal(requests[0].options.headers.cookie, undefined)
  assert.equal(requests[0].options.headers.referer, undefined)
})

test('loading refuses private destinations, plain http redirects, non-images, errors and oversized bodies', async (t) => {
  let requests = upstream(t, [], '10.0.0.1')
  await assert.rejects(loadRemoteImage('https://internal.example.com/a.png'))
  assert.equal(requests.length, 0, 'a private address is refused before connecting')
  t.mock.restoreAll()
  requests = upstream(t, [{ statusCode: 302, headers: { location: 'http://images.example.com/a.png' }, chunks: [] }])
  await assert.rejects(loadRemoteImage('https://images.example.com/a.png'), /HTTPS required/)
  assert.equal(requests.length, 1, 'the http hop is never opened')
  t.mock.restoreAll()
  for (const reply of [
    { statusCode: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')] },
    { statusCode: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('<!doctype html><script>alert(1)</script>')] },
    { statusCode: 404, headers: {}, chunks: [PNG] },
    { statusCode: 200, headers: { 'content-length': String(MAX_IMAGE_FETCH_BYTES + 1) }, chunks: [] },
    { statusCode: 200, headers: {}, chunks: [PNG, Buffer.alloc(MAX_IMAGE_FETCH_BYTES)] },
  ]) {
    upstream(t, [reply])
    await assert.rejects(loadRemoteImage('https://images.example.com/a.png'))
    t.mock.restoreAll()
  }
})

test('with remote images off, a remote image is refused at publish', (t) => {
  process.env.FX0_REMOTE_IMAGES = '0'
  t.after(() => { delete process.env.FX0_REMOTE_IMAGES })
  assert.equal(validateDesignArtifactHtml(doc('<img src="https://example.com/a.png">')).ok, false)
})
