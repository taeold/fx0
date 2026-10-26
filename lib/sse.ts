// Streams StreamItems to the browser as server-sent events. Takes the place of fx0 main's
// lib/event-stream.ts, which read them from the Redis journal; here they come from the actor.
import type { StreamItem } from './events'

const HEARTBEAT_MS = 15_000

export function sseResponse(
  items: (signal: AbortSignal) => AsyncIterable<StreamItem>,
  { after, closeWhen, headers }: { after: number; closeWhen?: (item: StreamItem) => boolean; headers?: HeadersInit },
): Response {
  const abort = new AbortController()
  let cancelled = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<string>({
    async start(controller) {
      heartbeat = setInterval(() => controller.enqueue(': ping\n\n'), HEARTBEAT_MS)
      try {
        for await (const item of items(abort.signal)) {
          if ((item.seq ?? 0) <= after) continue
          controller.enqueue(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`)
          if (closeWhen?.(item)) break
        }
      } catch (error) {
        if (!abort.signal.aborted) controller.enqueue(`data: ${JSON.stringify({ type: 'error', text: `chat unavailable: ${String((error as Error)?.message ?? error)}` })}\n\n`)
      }
      clearInterval(heartbeat)
      abort.abort()
      if (!cancelled) controller.close()
    },
    cancel() {
      cancelled = true
      clearInterval(heartbeat)
      abort.abort()
    },
  })
  return new Response(body.pipeThrough(new TextEncoderStream()), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...headers },
  })
}
