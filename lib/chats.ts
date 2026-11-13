// A chat is an actor (lib/actors.ts): a Vercel Drive, and the Vercel Sandbox that mounts it and
// runs libfx on it (actor/). This reads the chat as StreamItems.
import { readFileSync } from 'node:fs'
import { DEFAULT_VIEW } from '../components/chat-state'
import { actors } from './actors'
import { createConverter } from './convert'
import type { SessionInfo, StreamItem } from './events'
import { compactTranscript, type SessionSnapshot } from './transcript'

export const MODEL = process.env.FX_MODEL ?? 'anthropic/claude-haiku-5.5'
// Every chat runs on MODEL, so a listed chat's picker needs no settings request.
const GENERATION = { model: MODEL, effort: '', fast: false }

const chats = actors({
  prefix: process.env.FX_CHAT_PREFIX ?? 'fx0-chat-',
  image: 'fx0-actor:durable', // actor/, pushed with: vercel vcr build docker actor fx0-actor:durable --push
  port: 3000,
  mount: '/workspace',
  idleMs: 15 * 60_000,
  start: { cmd: 'node', args: ['/app/server.ts'] },
  env: { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? '', FX_MODEL: MODEL },
  // The image predates the mount epoch in server.ts.
  files: [{ path: '/app/server.ts', content: readFileSync('actor/server.ts', 'utf8') }],
})

export function validChatId(id: string | null): id is string {
  return !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
}

// Only a chat's first message makes its Drive (`create`).
export async function chatFetch(chat: string, path: string, init: RequestInit = {}, { create = false } = {}): Promise<Response> {
  return chats.fetch(chat, path, init, { create })
}

export async function chatExists(chat: string): Promise<boolean> {
  return (await chats.get(chat)) != null
}

// A chat with no Drive yet is a draft, and waking it would make one.
export async function wakeChat(chat: string): Promise<void> {
  if (await chatExists(chat)) await chatFetch(chat, '/summary')
}

export async function deleteChat(chat: string): Promise<void> {
  await chats.delete(chat)
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
  const actor = await chats.get(chat)
  return {
    transcript,
    summary: first ? {
      id: chat,
      title: titles.get(chat) ?? null,
      createdAt: first.at ?? actor?.createdAt ?? Date.now(),
      lastActivity: prompts.at(-1)?.at ?? actor?.updatedAt ?? Date.now(),
      busy: transcript.activeTurnId != null,
      generation: GENERATION,
    } : null,
  }
}

export function rememberTitle(chat: string, text: string): void {
  if (text && !titles.has(chat)) titles.set(chat, text.slice(0, 40))
}

export async function listChats(): Promise<SessionInfo[]> {
  const listed = (await chats.list()).filter((actor) => validChatId(actor.name))
  const sessions = await Promise.all(listed.map(async ({ name: id, createdAt, updatedAt, awake }): Promise<SessionInfo> => {
    let busy = false
    // A running actor answers at once; a stopped one is not woken for a title.
    if (awake) {
      const summary = await chats.fetch(id, '/summary', { signal: AbortSignal.timeout(5_000) })
        .then((response) => response.json() as Promise<{ title: string | null; busy: boolean }>)
        .catch(() => null)
      if (summary?.title) rememberTitle(id, summary.title)
      busy = summary?.busy ?? false
    }
    return { id, title: titles.get(id) ?? null, createdAt, lastActivity: updatedAt, busy, generation: GENERATION }
  }))
  return sessions.toSorted((a, b) => b.lastActivity - a.lastActivity)
}

export async function readDesignHtml(chat: string | null, revision: string | null): Promise<{ html: string | null; past: boolean }> {
  const number = Number(revision)
  const past = Number.isSafeInteger(number) && number > 0
  if (!validChatId(chat) || !(await chatExists(chat))) return { html: null, past }
  const response = await chatFetch(chat, past ? `/versions/${number}` : '/design')
  return { html: response.ok ? await response.text() : null, past }
}
