# fx0 on durable sandboxes

fx0 is an open-source design agent built with [libfx](https://www.npmjs.com/package/libfx). You describe a page and an agent writes it as one HTML file.

This branch rebuilds fx0's backend so that each chat gets its own Vercel Drive and its own Vercel Sandbox. fx0's UI components are unchanged. It is a single-user, local proof of concept, based on fx0 as of October 24, 2026 (`d8295b4`).

## The idea

A Vercel Drive is a disk that only one sandbox can mount at a time. If every chat is a Drive, the sandbox that has it mounted is the only process that can change that chat. So the chat's program can be written as if it were the only chat in the world. It keeps its state in plain files and never coordinates with anything. A small router in the app finds the sandbox that has a chat's Drive mounted, or starts one.

It's the Durable Objects model. You write one program for one chat, and every chat runs its own copy.

## How it works

A chat is a Drive named `fx0-chat-<id>`. Everything the chat has lives on it:

- `.fx/sessions/`: the libfx session, through libfx's `local()` durability.
- `design.html`: the current design.
- `versions/<n>.html`: every revision the agent published.
- `assets/`: images attached to messages, which a design can show.

The chat's actor is the sandbox that mounts the Drive at `/workspace` and runs [`actor/server.ts`](actor/server.ts). The actor runs one libfx agent and serves a few routes: send a message, cancel, read the event log, read the design or a version, read an attached image.

The Next.js app keeps fx0's pages and API routes. Each route asks [`lib/chats.ts`](lib/chats.ts) for the chat's actor and forwards the request to it. `lib/chats.ts` is the only file in the app that talks to Vercel. [`lib/convert.ts`](lib/convert.ts) turns the actor's libfx log into the stream items fx0's UI already renders.

Every message is a libfx steer named by the client's message id. A steer starts a turn when none runs, and joins the running turn otherwise.

A sandbox lives 15 minutes from when it starts. After that the chat is just its Drive. The next request for the chat starts a new sandbox on the same Drive, and the chat picks up where it was. Stopping a sandbox sends SIGTERM, and the actor finishes the running turn before it exits if it can do that in the roughly 20 seconds Vercel allows. See [Limits](#limits) for what happens when it can't.

A turn stops after 64 model steps, so an agent stuck in a loop cannot run up a bill ([`actor/turn-budget.ts`](actor/turn-budget.ts)).

## What the Drive replaced

fx0 on `main` serves many users from short-lived functions, so every chat's state lives in shared services and every write has to coordinate with the others. Here each job moves onto the chat's own disk or into its own process.

| Job | fx0 on `main` | This branch |
| --- | --- | --- |
| Keep the libfx session durable | Workflow World | libfx `local()` files on the chat's Drive |
| Run turns, deliver steers, outlive the 800 s function limit | Vercel Queues and a wake route | The actor's process runs the turn; a steer goes straight to it |
| Keep the transcript the UI follows | Redis journal, projector and draft store | The libfx log, converted on read by `lib/convert.ts` |
| Keep two writers from colliding | Leases in Workflow World, fences and atomic scripts in Redis | The Drive's one-mount rule |
| Keep design versions and the chat list | Postgres | Files on the Drive, and `Drive.list` |
| Keep attached images | Vercel Blob plus a Redis manifest and cleanup queue | Files on the Drive, served by the actor |
| Accounts, billing, free trial, bot protection | Postgres, sealed credentials, BotID | Removed: one local user |

Five backing services become two: Drive and Sandbox. AI Gateway is the same on both.

## What got simpler

The actor never sees a chat id. Its one session id is libfx's own. On `main`, the Redis journal alone mentions `sessionId` 98 times, because every read and write has to say which chat it is about.

Saving a design shows the difference. On `main`, publishing runs one atomic Redis script over eight keys and then copies the version into Postgres:

```ts
// lib/journal.ts on main, trimmed
await redis().eval(PUBLISH_DESIGN_ARTIFACT, [
  key(sessionId, 'deleting'),        // was the chat deleted meanwhile?
  key(sessionId, 'state'),           // the revision counter
  key(sessionId, 'design-artifact'), // the current HTML
  key(sessionId, 'event-seq'),       // numbering for the UI's event stream
  key(sessionId, 'events'),          // the stream the browser follows
  key(sessionId, 'draft'), key(sessionId, 'draft-chunks'), key(sessionId, 'turn-designs'),
], [...])
```

Each key answers a question that only comes up when many processes share one store. On the actor there is one writer and one disk, so the same step is:

```ts
// actor/design.ts
const revision = (await listVersions()).length + 1;
await writeFile(`${VERSIONS}/${revision}.html`, html);
await writeFile(`${DESIGN}.tmp`, html);
await rename(`${DESIGN}.tmp`, DESIGN);
```

The code that keeps chat state and runs turns went from about 2,100 lines to about 540. On `main` that is `lib/journal.ts`, `lib/projector.ts`, `lib/event-stream.ts`, `lib/history.ts`, `lib/libfx-agent.ts`, `lib/session.ts`, `lib/design-assets.ts`, the wake route and `vercel.json` (about 2,700 lines counting `lib/agent.ts`, which also handles billing). Here it is `actor/server.ts`, `lib/chats.ts`, `lib/convert.ts` and `lib/sse.ts`. Lines are counted with `wc -l`, comments included, and the design tools are left out of both sides.

## What it costs

The services this branch drops were doing real work:

- **Reading a chat that isn't running.** On `main`, the app reads any chat from Redis or Postgres without running anything. Here a Drive can only be read from a sandbox, so opening a sleeping chat starts one, which took about 1.5 to 3 seconds in our tests.
- **Questions across chats.** Listing everything a user owns, search, usage totals: one query on `main`. Here they would mean waking every chat.
- **Recovery.** Vercel Queues retry a crashed turn on their own. Here nothing runs until a request arrives, and a crash mid-turn leaves the chat stuck (see [Limits](#limits)).
- **Density.** Thousands of idle chats cost almost nothing on `main`. Here each awake chat is a whole VM, and each Drive takes at least 1 GiB of storage quota.

Going multi-user would bring a database back, for accounts, ownership and an index of chats with their titles. It would not hold chat state. The database becomes a directory of actors.

## Run it

You need Node.js 24, the Vercel CLI, and a Vercel project linked to a directory.

1. Build and push the actor image from the linked directory:

   ```sh
   vercel vcr login docker
   vercel vcr build docker /path/to/fx0/actor fx0-actor --push
   ```

2. Copy `.env.example` to `.env.local` and fill it in. `VERCEL_OIDC_TOKEN` comes from `vercel env pull` and expires after about 12 hours; pull it again when chat requests start failing.
3. Start the app:

   ```sh
   npm install
   npm run build
   npm start
   ```

   Open it at `http://localhost:3000`. To open it from another hostname, such as a tunnel, use `npm start` as above. `npm run dev` blocks Next.js dev resources for any host but localhost, so the page never becomes interactive.

`npm run sleep-chat <id>` stops a chat's sandbox, as its 15-minute limit would.

## Check it

`npm run actors` checks the one-sandbox-per-chat design against the running app ([`scripts/actors.mjs`](scripts/actors.mjs)). Five chats run a turn at once, each on its own sandbox, and none holds another's messages or design. All five sleep and wake with their history. Two first messages racing for one new chat land in the same sandbox. The check creates six chats, prints their ids, and costs a few cents in model calls.

`npm test` runs the unit tests.

## Limits

- The actor has no authentication, and sandbox URLs are public. Anyone who learns a chat's sandbox URL can read the chat and send it messages. The app never shows these URLs, but don't run this with chats you need to keep private.
- A turn that is cut off never resumes, and its chat stays stuck, with new messages waiting behind it. This happens when the actor crashes mid-turn, or when its sandbox stops while a turn needs more than about 20 seconds to finish. libfx's `local()` durability assumes its directory stays on one machine. It records which process on which host holds the session, and it can't tell whether a process on another host is still alive, so the record a dead sandbox leaves behind never lapses.
- Nothing wakes a chat on its own. A chat runs only when a request reaches it.
- Every Drive is at least 1 GiB and a Hobby team gets 15 GiB, so a Hobby team holds at most 15 chats, awake or asleep. A chat uses about 1 MB of its Drive.
- Chat titles come from each chat's first prompt, which only its actor can read. The app remembers the titles it has seen, so after a restart a chat whose sandbox is asleep shows as "new chat" until you open it.
- libfx's stream lines carry no times, so turn and tool durations are not shown.
- The model is fixed by `FX_MODEL`. The model, team, credit and sign-in routes return fixed values.
- The agent cannot ask questions, run subagents, or search the web. It can fetch pages.
- Designs do not stream into the preview while the agent writes them, because libfx reports a tool call's input only once it is complete.
