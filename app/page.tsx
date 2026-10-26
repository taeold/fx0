import { connection } from 'next/server.js'
import ChatApp, { type AccountBoot, type ChatBoot } from '../components/chat-app'
import type { PagePreference } from '../components/composer'
import { DEFAULT_VIEW } from '../components/chat-state'
import { chatExists, listChats, MODEL, readChat, validChatId } from '../lib/chats'
import { LOCAL_USER } from '../lib/local-user'
import { compactTranscript } from '../lib/transcript'

async function loadChat(searchParams: PageProps<'/'>['searchParams']): Promise<ChatBoot> {
  await connection()
  const draft: ChatBoot = { sessionId: 'draft', snapshot: { transcript: compactTranscript([], DEFAULT_VIEW), summary: null }, now: Date.now(), missing: false }
  const params = await searchParams
  const requested = Array.isArray(params.s) ? params.s[0] : params.s
  if (!requested) return draft
  if (!validChatId(requested) || !(await chatExists(requested))) return { ...draft, missing: true }
  return { sessionId: requested, snapshot: await readChat(requested), now: Date.now(), missing: false }
}

// Consumers stream independently; only the chat waits for its actor.
export default function Page({ searchParams }: PageProps<'/'>) {
  const account: Promise<AccountBoot> = Promise.resolve({ user: LOCAL_USER, team: null, freePrompts: null })
  const sidebar = connection().then(async () => ({ sessions: await listChats(), nextCursor: null }))
  const boot = loadChat(searchParams)
  const preference: Promise<PagePreference> = boot.then(({ sessionId }) => ({ sessionId, model: MODEL, effort: '', fast: false }))
  return <ChatApp account={account} sidebar={sidebar} boot={boot} preference={preference} defaultModel={MODEL} />
}
