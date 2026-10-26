// Stops a chat's sandbox, as its 15-minute limit would. The chat's next request starts a new
// sandbox on the same Drive, which shows the chat surviving its machine.
import { Drive, Sandbox } from '@vercel/sandbox'

const chat = process.argv[2]
const drive = await Drive.get({ name: `fx0-chat-${chat}` })
if (drive.currentSandboxName) await (await Sandbox.get({ name: drive.currentSandboxName })).stop()
console.log(drive.currentSandboxName ? `stopped ${drive.currentSandboxName}` : 'already asleep')
