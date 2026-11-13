# fx0 on durable sandboxes

fx0 is an open-source design agent built with [libfx](https://www.npmjs.com/package/libfx). You describe a page and an agent writes it as one HTML file.

This branch is a single-user proof of concept. It runs fx0's unchanged UI on two pieces of infrastructure: one Vercel Drive per chat, mounted by one Vercel Sandbox that runs libfx. There are no accounts, no Redis, no Postgres, and no Vercel Queues.

## How it works

A chat is a Drive named `fx0-chat-<id>`. Everything the chat has lives on it:

- `.fx/sessions/`: the libfx session, through libfx's `local()` durability.
- `design.html`: the current design.
- `versions/<n>.html`: every revision the agent published.

The chat's actor is the sandbox that mounts the Drive at `/workspace` and runs [`actor/server.ts`](actor/server.ts). Only one sandbox can mount a Drive, so that sandbox is the chat's single writer. When it stops, the next request starts a new one. A turn that was cut off continues from its last saved step.

Each start remounts the Drive `sync` and bumps a counter on it, so the new process treats anything an earlier one left behind as stale. A sandbox that is not listening 30 s after it started is stopped and replaced.

A turn stops after 64 model steps, so an agent stuck in a loop cannot run up a bill ([`actor/turn-budget.ts`](actor/turn-budget.ts)). The actor counts the model requests since the turn's last user message, so the count survives a restart. A steer is a user message, so it starts the count again.

The Next.js app finds or starts a chat's actor and forwards requests to it. [`lib/actors.ts`](lib/actors.ts) does that for any Drive and Sandbox pair, and [`lib/chats.ts`](lib/chats.ts) sets it up for fx0:

| fx0 on `main` | This branch |
| --- | --- |
| Workflow World keeps the libfx session | libfx `local()` durability on the chat's Drive |
| Redis journal, projector and draft store | The libfx log, converted on read by [`lib/convert.ts`](lib/convert.ts) |
| Neon accounts, ownership and versions | One local user; versions are files on the Drive |
| Vercel Queues runs turns past 800 s and delivers steers | The actor's process runs the turn; a steer goes to it directly |

Every message is a libfx steer named by the client's message id. A steer starts a turn when none runs, and joins the running turn otherwise.

## Run it

You need Node.js 24, the Vercel CLI, and a Vercel project linked to a directory.

1. Build and push the actor image from the linked directory:

   ```sh
   vercel vcr login docker
   vercel vcr build docker /path/to/fx0/actor fx0-actor:durable --push
   ```

2. Copy `.env.example` to `.env.local` and fill it in.
3. Start the app:

   ```sh
   npm install
   npm run build
   npm start
   ```

   Open it at `http://localhost:3000`. To open it from another hostname, such as a tunnel, use `npm start` as above: `npm run dev` blocks Next.js dev resources for any host but localhost, so the page never becomes interactive.

`npm run sleep-chat <id>` stops a chat's sandbox, as its idle timeout would.

To run it on Vercel, push the image to the project you deploy to, set `AI_GATEWAY_API_KEY` on that project, and run `vercel deploy`. The app has no sign-in, so everyone who opens a deployment shares one chat list.

## Limits

- Chat titles come from each chat's first prompt, which only its actor can read. The app remembers the titles it has seen, so after a restart a chat whose sandbox is asleep shows as "new chat" until you open it.
- libfx's stream lines carry no times, so turn and tool durations are not shown.
- The model is fixed by `FX_MODEL`. The model, team, credit and sign-in routes return fixed values.
- The agent cannot ask questions, run subagents, or search the web. It can fetch pages.
- Designs do not stream into the preview while the agent writes them: libfx reports a tool call's input only once it is complete.
