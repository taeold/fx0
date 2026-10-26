// A chat is a Vercel Drive named fx0-chat-<id>. Its actor is the Vercel Sandbox that mounts the
// Drive and runs actor/server.ts. This file finds or starts that sandbox, forwards requests to
// it, and reads the chat as StreamItems. It is the only app file that talks to Vercel.
//
// It takes the place of fx0 main's chat state and lookups (lib/journal.ts, lib/history.ts,
// lib/accounts.ts): the Drive list is the chat list, and the Drive's one-mount rule is the lock.
import { APIError, Drive, Sandbox } from '@vercel/sandbox'
import { DEFAULT_VIEW } from '../components/chat-state'
import { createConverter } from './convert'
import type { SessionInfo, StreamItem } from './events'
import { compactTranscript, type SessionSnapshot } from './transcript'

export const MODEL = process.env.FX_MODEL ?? 'anthropic/claude-haiku-5.5'
// Every chat runs on MODEL, so a listed chat's picker needs no settings request.
const GENERATION = { model: MODEL, effort: '', fast: false }

const PREFIX = 'fx0-chat-'
const PORT = 3000
const IDLE_MS = 15 * 60_000

export function validChatId(id: string | null): id is string {
  return !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
}

// Only a chat's first message makes its Drive (`create`).
export async function chatFetch(chat: string, path: string, init: RequestInit = {}, { create = false } = {}): Promise<Response> {
  return forward(await sandboxFor(PREFIX + chat, create), path, init)
}

export async function chatExists(chat: string): Promise<boolean> {
  return (await driveOf(chat)) != null
}

// A chat with no Drive yet is a draft, and waking it would make one.
export async function wakeChat(chat: string): Promise<void> {
  if (await chatExists(chat)) await chatFetch(chat, '/summary')
}

export async function deleteChat(chat: string): Promise<void> {
  const name = (await driveOf(chat))?.currentSandboxName
  if (name) await (await Sandbox.get({ name })).stop()
  // A Drive can be deleted only once its sandbox has let it go.
  for (let attempt = 0; attempt < 60; attempt++) {
    const drive = await driveOf(chat)
    if (!drive) return
    if (!drive.currentSandboxName) return drive.delete()
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`the chat ${chat} is still mounted`)
}

export async function* chatItems(chat: string, { follow, signal }: { follow: boolean; signal?: AbortSignal }): AsyncGenerator<StreamItem> {
  const response = await chatFetch(chat, `/events?follow=${follow ? 1 : 0}`, { signal })
  if (!response.ok || !response.body) throw new Error(`the chat's events failed with ${response.status}`)
  const convert = createConverter()
  let buffer = ''
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.trim()) yield* convert(JSON.parse(line))
    }
  }
}

// Titles are a chat's first prompt. The chat keeps it on its Drive, which only its actor
// can read, so the titles this process has seen are kept here to list chats without
// starting their actors.
const titles = new Map<string, string>()

export async function readChat(chat: string): Promise<SessionSnapshot> {
  const items: StreamItem[] = []
  for await (const item of chatItems(chat, { follow: false })) items.push(item)
  const transcript = compactTranscript(items, DEFAULT_VIEW)
  const first = items.find((item) => item.type === 'user')
  rememberTitle(chat, first?.text ?? '')
  const prompts = items.filter((item) => item.type === 'user')
  const drive = await driveOf(chat)
  return {
    transcript,
    summary: first ? {
      id: chat,
      title: titles.get(chat) ?? null,
      createdAt: first.at ?? drive?.createdAt.getTime() ?? Date.now(),
      lastActivity: prompts.at(-1)?.at ?? drive?.updatedAt.getTime() ?? Date.now(),
      busy: transcript.activeTurnId != null,
      generation: GENERATION,
    } : null,
  }
}

export function rememberTitle(chat: string, text: string): void {
  if (text && !titles.has(chat)) titles.set(chat, text.slice(0, 40))
}

export async function listChats(): Promise<SessionInfo[]> {
  const drives = await (await Drive.list({ namePrefix: PREFIX, sortBy: 'name' })).toArray()
  const chats = await Promise.all(drives.filter((drive) => validChatId(drive.name.slice(PREFIX.length))).map(async (drive): Promise<SessionInfo> => {
    const id = drive.name.slice(PREFIX.length)
    let busy = false
    // A running actor answers at once; a stopped one is not woken for a title.
    if (drive.currentSandboxName) {
      const summary = await forward(await Sandbox.get({ name: drive.currentSandboxName }), '/summary', { signal: AbortSignal.timeout(5_000) })
        .then((response) => response.json() as Promise<{ title: string | null; busy: boolean }>)
        .catch(() => null)
      if (summary?.title) rememberTitle(id, summary.title)
      busy = summary?.busy ?? false
    }
    return { id, title: titles.get(id) ?? null, createdAt: drive.createdAt.getTime(), lastActivity: drive.updatedAt.getTime(), busy, generation: GENERATION }
  }))
  return chats.toSorted((a, b) => b.lastActivity - a.lastActivity)
}

async function driveOf(chat: string): Promise<Drive | null> {
  try {
    return await Drive.get({ name: PREFIX + chat })
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return null
    throw error
  }
}

// Only one sandbox can mount a Drive, so the sandbox that does is the chat's.
async function sandboxFor(name: string, create: boolean, attempt = 1): Promise<Sandbox> {
  const drive = create ? await Drive.getOrCreate({ name }) : await Drive.get({ name })
  try {
    if (drive.currentSandboxName) return await Sandbox.get({ name: drive.currentSandboxName })
    const sandbox = await Sandbox.create({
      image: 'fx0-actor', // actor/, pushed with: vercel vcr build docker actor fx0-actor --push
      mounts: { '/workspace': drive },
      ports: [PORT],
      timeout: IDLE_MS,
      persistent: false,
      env: { PORT: String(PORT), AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? '', FX_MODEL: MODEL },
    })
    await sandbox.runCommand({ cmd: 'node', args: ['/app/server.ts'], detached: true })
    return sandbox
  } catch (error) {
    // Another request is starting this chat's sandbox. Vercel refused ours (409),
    // or theirs is named on the Drive but cannot be read yet (404). Look again.
    const racing = error instanceof APIError && (error.response.status === 409 || error.response.status === 404)
    if (!racing || attempt === 5) throw error
    await new Promise((resolve) => setTimeout(resolve, 300))
    return sandboxFor(name, create, attempt + 1)
  }
}

async function forward(sandbox: Sandbox, path: string, init: RequestInit): Promise<Response> {
  // A new sandbox needs a moment before its program listens. Until then, Vercel's proxy answers
  // SANDBOX_NOT_LISTENING without passing the request on, so sending it again is safe.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(sandbox.domain(PORT) + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' }, // stream replies instead of buffering them
    })
    if (response.headers.get('x-vercel-error') !== 'SANDBOX_NOT_LISTENING') return response
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return new Response("The chat's program did not start listening within 30 s\n", { status: 504 })
}

export async function readDesignHtml(chat: string | null, revision: string | null): Promise<{ html: string | null; past: boolean }> {
  const number = Number(revision)
  const past = Number.isSafeInteger(number) && number > 0
  if (!validChatId(chat) || !(await chatExists(chat))) return { html: null, past }
  const response = await chatFetch(chat, past ? `/versions/${number}` : '/design')
  return { html: response.ok ? await response.text() : null, past }
}

/** An image a message attached, from the chat's Drive, or null when the chat has none by that handle. */
export async function readDesignAsset(chat: string, handle: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!(await chatExists(chat))) return null
  const response = await chatFetch(chat, `/assets/${handle}`)
  if (!response.ok) return null
  return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get('content-type') ?? 'application/octet-stream' }
}
