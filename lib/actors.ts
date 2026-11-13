// An actor is a Vercel Drive and the one Vercel Sandbox that mounts it. Only one sandbox can
// mount a Drive, so the sandbox that does is the actor, and the Drive outlives it.
import { APIError, Drive, Sandbox } from '@vercel/sandbox'

export type ActorOptions = {
  prefix: string
  image: string
  port: number
  mount: string
  idleMs: number
  start: { cmd: string; args: string[] }
  env: Record<string, string>
  // Program files newer than the image, written before it starts.
  files?: { path: string; content: string }[]
}

export type ActorInfo = { name: string; createdAt: number; updatedAt: number; awake: boolean }

export function actors({ prefix, image, port, mount, idleMs, start, env, files = [] }: ActorOptions) {
  async function driveOf(name: string): Promise<Drive | null> {
    try {
      return await Drive.get({ name: prefix + name })
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return null
      throw error
    }
  }

  const info = (drive: Drive): ActorInfo => ({
    name: drive.name.slice(prefix.length),
    createdAt: drive.createdAt.getTime(),
    updatedAt: drive.updatedAt.getTime(),
    awake: drive.currentSandboxName != null,
  })

  async function sandboxFor(name: string, create: boolean, attempt = 1): Promise<Sandbox> {
    const drive = create ? await Drive.getOrCreate({ name: prefix + name }) : await Drive.get({ name: prefix + name })
    try {
      if (drive.currentSandboxName) return await Sandbox.get({ name: drive.currentSandboxName })
      return await boot(drive)
    } catch (error) {
      // Another request is starting this actor's sandbox. Vercel refused ours (409),
      // or theirs is named on the Drive but cannot be read yet (404). Look again.
      const racing = error instanceof APIError && (error.response.status === 409 || error.response.status === 404)
      if (!racing || attempt === 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 300))
      return sandboxFor(name, create, attempt + 1)
    }
  }

  // Each boot bumps the epoch on the Drive. Only this sandbox can mount it, so the read and
  // write cannot race, and anything an earlier epoch left behind belongs to a process that is gone.
  // The sync mount makes each write reach the Drive before it returns: by default the kernel
  // keeps writes for up to 30 s, and a crash leaves empty files where they were.
  async function boot(drive: Drive): Promise<Sandbox> {
    const sandbox = await Sandbox.create({
      name: `${drive.name}-${Date.now().toString(36)}`,
      image,
      mounts: { [mount]: drive },
      ports: [port],
      timeout: idleMs,
      persistent: false,
      env: { ...env, PORT: String(port) },
    })
    if (files.length) await sandbox.writeFiles(files)
    const dir = `${mount}/.actor`
    const script = `set -e; mount -o remount,sync ${mount}; mkdir -p ${dir}
e=$(( $(cat ${dir}/epoch 2>/dev/null || echo 0) + 1 )); echo $e > ${dir}/epoch.new; mv ${dir}/epoch.new ${dir}/epoch
ACTOR_EPOCH=$e exec "$@"`
    await sandbox.runCommand({ cmd: 'sh', args: ['-c', script, 'actor', start.cmd, ...start.args], detached: true })
    return sandbox
  }

  // A new sandbox needs a moment before its program listens. Until then, Vercel's proxy answers
  // SANDBOX_NOT_LISTENING without passing the request on, so sending it again is safe. A sandbox
  // still not listening 30 s after it started has lost its program, usually with its VM, and
  // Vercel goes on reporting it running and holding the Drive. Null means that.
  async function forward(sandbox: Sandbox, path: string, init: RequestInit): Promise<Response | null> {
    const deadline = sandbox.createdAt.getTime() + 30_000
    for (;;) {
      const response = await fetch(sandbox.domain(port) + path, {
        ...init,
        headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' }, // stream replies instead of buffering them
      })
      if (response.headers.get('x-vercel-error') !== 'SANDBOX_NOT_LISTENING') return response
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // A Drive can be mounted again, or deleted, only once its sandbox has let it go.
  async function stop(name: string): Promise<void> {
    const current = (await driveOf(name))?.currentSandboxName
    if (!current) return
    await (await Sandbox.get({ name: current })).stop()
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await driveOf(name))?.currentSandboxName !== current) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`the actor ${name} is still mounted`)
  }

  return {
    // Only `create` makes the actor's Drive.
    async fetch(name: string, path: string, init: RequestInit = {}, { create = false } = {}): Promise<Response> {
      const response = await forward(await sandboxFor(name, create), path, init)
      if (response) return response
      await stop(name)
      return (await forward(await sandboxFor(name, false), path, init))
        ?? new Response("The actor's program did not start listening within 30 s\n", { status: 504 })
    },

    async get(name: string): Promise<ActorInfo | null> {
      const drive = await driveOf(name)
      return drive && info(drive)
    },

    async list(): Promise<ActorInfo[]> {
      return (await (await Drive.list({ namePrefix: prefix, sortBy: 'name' })).toArray()).map(info)
    },

    stop,

    async delete(name: string): Promise<void> {
      for (let attempt = 1; ; attempt++) {
        await stop(name)
        try {
          await (await driveOf(name))?.delete()
          break
        } catch (error) {
          // A request woke the actor again between the stop and the delete.
          const attached = error instanceof APIError && (error.json as { error?: { code?: string } })?.error?.code === 'drive_attached'
          if (!attached || attempt === 5) throw error
        }
      }
      for (const sandbox of await (await Sandbox.list({ namePrefix: prefix + name, sortBy: 'name' })).toArray()) {
        await (await Sandbox.get({ name: sandbox.name })).delete()
      }
    },
  }
}
