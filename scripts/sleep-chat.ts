// Stops a chat's sandbox, as its idle timeout would. The chat's next request starts a new one.
import { Drive, Sandbox } from '@vercel/sandbox'

const chat = process.argv[2]
const drive = await Drive.get({ name: `fx0-chat-${chat}` })
if (drive.currentSandboxName) await (await Sandbox.get({ name: drive.currentSandboxName })).stop()
console.log(drive.currentSandboxName ? `stopped ${drive.currentSandboxName}` : 'already asleep')
