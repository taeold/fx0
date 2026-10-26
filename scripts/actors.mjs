// Does "one program per chat, run N times" hold on the running app? Drives the app's HTTP API,
// the same routes the browser uses, and uses the Vercel SDK to sleep or kill actors. Against a
// running app (BASE, default http://localhost:3000):
//   node --env-file=.env.local scripts/actors.mjs
import assert from 'node:assert/strict'
import { Drive, Sandbox } from '@vercel/sandbox'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const N = Number(process.env.N ?? 5)
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a)
const clientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// Sends a message and follows the stream to the end of its turn, as the composer does.
// Returns the chat id, the items seen, and the moment the first item arrived.
// afterSeq skips the replay of earlier items, so every item seen is from this turn.
// accept-encoding: identity, or Node's fetch lets the server gzip the event stream and hold it.
async function prompt(session, text, { onItem, onAccepted, afterSeq = 0, signal } = {}) {
  const res = await fetch(`${BASE}/api/prompt?session=${session}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' }, signal,
    body: JSON.stringify({ text, clientId: clientId(), afterSeq }),
  })
  assert.equal(res.status, 200, `prompt ${session}: ${res.status} ${await res.clone().text()}`)
  const id = res.headers.get('x-fx0-session') ?? session
  onAccepted?.()
  const items = []
  let first
  for await (const item of sse(res.body)) {
    first ??= Date.now()
    items.push(item)
    await onItem?.(item, items)
  }
  return { id, items, first }
}

async function* sse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true })
    let end
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, end); buf = buf.slice(end + 2)
      const data = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (data) yield JSON.parse(data.slice(6))
    }
  }
}

// The transcript is fx0's reduced state: entries (user, text, tool, status, divider) plus activeTurnId.
const transcript = async (id) => (await (await fetch(`${BASE}/api/session?session=${id}`)).json()).transcript
const userTexts = (t) => t.entries.filter((i) => i.type === 'user').map((i) => i.text)
const design = async (id) => (await fetch(`${BASE}/api/artifact?session=${id}`)).text()
const driveOf = (id) => Drive.get({ name: `fx0-chat-${id}` })
async function stopSandbox(id) {
  const drive = await driveOf(id)
  if (!drive.currentSandboxName) return 'already asleep'
  await (await Sandbox.get({ name: drive.currentSandboxName })).stop()
  return drive.currentSandboxName
}

let chats = []
const tokens = Array.from({ length: N }, (_, i) => `ZQ${i}${Math.random().toString(36).slice(2, 6).toUpperCase()}`)
const report = {}

log(`1. ${N} new chats, one turn each, all at once`)
const started = Date.now()
const firstTurns = await Promise.all(tokens.map((token, i) =>
  prompt('new', `A one-screen landing page for a bakery. The page title and the main headline must contain the exact word ${token}. Keep it small.`)
    .then((r) => ({ ...r, token, index: i }))))
chats = firstTurns.map((r) => r.id)
for (const r of firstTurns) {
  assert.ok(r.items.some((i) => i.type === 'done'), `chat ${r.index} finished its turn`)
  assert.ok(!r.items.some((i) => i.type === 'error'), `chat ${r.index} had no error: ${JSON.stringify(r.items.filter((i) => i.type === 'error'))}`)
}
const drives = await Promise.all(chats.map(driveOf))
const sandboxes = drives.map((d) => d.currentSandboxName)
assert.equal(new Set(sandboxes).size, N, 'each chat has its own sandbox')
report.parallel = {
  chats: N, wall: Date.now() - started,
  firstItemMs: firstTurns.map((r) => r.first - started),
  sandboxes,
}
log('all turns done in', report.parallel.wall, 'ms; first item at', report.parallel.firstItemMs.join('/'), 'ms; sandboxes', sandboxes.join(' '))

log('2. isolation: each chat holds only its own messages and design')
for (const { id, token, index } of firstTurns) {
  const texts = userTexts(await transcript(id)).join('\n')
  const html = await design(id)
  assert.ok(texts.includes(token), `chat ${index} transcript has its token`)
  assert.ok(html.includes(token), `chat ${index} design has its token`)
  for (const other of tokens) if (other !== token) {
    assert.ok(!texts.includes(other), `chat ${index} transcript lacks ${other}`)
    assert.ok(!html.includes(other), `chat ${index} design lacks ${other}`)
  }
}
const listed = (await (await fetch(`${BASE}/api/sessions`)).json())
const listedIds = new Set((listed.sessions ?? listed).map((s) => s.id))
for (const id of chats) assert.ok(listedIds.has(id), `chat list (Drive.list) has ${id}`)
log('isolated; chat list has all', N)

log(`3. sleep all ${N}, then a message to each wakes it with history`)
const stopped = await Promise.all(chats.map(stopSandbox))
log('stopped', stopped.join(' '))
const wakeStarted = Date.now()
const second = await Promise.all(firstTurns.map(({ id, token }) =>
  prompt(id, `Change the headline color to green. Keep the word ${token}.`)))
for (const [i, r] of second.entries()) {
  assert.ok(r.items.some((x) => x.type === 'done') && !r.items.some((x) => x.type === 'error'), `chat ${i} second turn finished`)
}
const woken = await Promise.all(chats.map(driveOf))
for (const [i, d] of woken.entries()) assert.notEqual(d.currentSandboxName, sandboxes[i], `chat ${i} runs on a new sandbox`)
for (const [i, { id, token }] of firstTurns.entries()) {
  const texts = userTexts(await transcript(id))
  assert.equal(texts.length, 2, `chat ${i} has both messages after waking`)
  assert.ok(texts.every((t) => t.includes(token)), `chat ${i} kept its own messages`)
}
report.wake = { wall: Date.now() - wakeStarted, firstItemMs: second.map((r) => r.first - wakeStarted), newSandboxes: woken.map((d) => d.currentSandboxName) }
log('all woke; first item at', report.wake.firstItemMs.join('/'), 'ms')

log('4. two first messages race for one new chat')
const fresh = crypto.randomUUID()
const raceStarted = Date.now()
const [a, b] = await Promise.all([
  prompt(fresh, 'A landing page for a bike shop called RACE-A. Keep it small.'),
  prompt(fresh, 'Also put a big orange button that says RACE-B.'),
])
const raceT = await transcript(fresh)
const raceTexts = userTexts(raceT)
const raceDrive = await driveOf(fresh)
report.race = { wall: Date.now() - raceStarted, sandbox: raceDrive.currentSandboxName, userMessages: raceTexts, turns: raceT.startedTurns.length, aFirstMs: a.first - raceStarted, bFirstMs: b.first - raceStarted }
log(JSON.stringify(report.race))
assert.ok(raceTexts.some((t) => t.includes('RACE-A')) && raceTexts.some((t) => t.includes('RACE-B')), 'both messages landed in the one chat')
assert.ok(raceDrive.currentSandboxName, 'one sandbox holds the Drive')
assert.ok(![...a.items, ...b.items].some((i) => i.type === 'error'), 'no error items in the raced chat')

console.log(JSON.stringify({ created: [...chats, fresh], report }, null, 2))
