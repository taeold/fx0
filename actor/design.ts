// fx0's design tools (read_design, publish_design, edit_design, web_fetch), reading and writing
// files on the chat's Drive. On fx0's main branch they live in lib/tools.ts, save each design
// through a Redis script in lib/journal.ts and copy versions into Postgres (lib/history.ts).
// With one writer per Drive, saving a version is writing the next file.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import type { FxAgentHostTool } from "libfx";

const DESIGN = "/workspace/design.html";
const VERSIONS = "/workspace/versions";
const MAX_BYTES = 512 * 1024;
const DOCTYPE = "<!doctype html>";

type Saved = { ok: true; revision: number; changed: boolean } | { ok: false; reason: string; error: string };

export async function readDesign(): Promise<string | null> {
  return readFile(DESIGN, "utf8").catch(() => null);
}

async function listVersions(): Promise<number[]> {
  const files = await readdir(VERSIONS).catch(() => []);
  return files.map((file) => Number(file.replace(".html", ""))).sort((a, b) => a - b);
}

// Every publish and edit keeps its own version, so any earlier design can be reopened.
async function save(raw: string): Promise<Saved> {
  // fx0 stores the form it renders: its preview puts the CSP right after a leading
  // doctype, and shows nothing for a design without one (lib/design-artifact.ts).
  const html = raw.trim().replace(/^<!doctype\s+html\s*>/i, DOCTYPE);
  if (Buffer.byteLength(html) > MAX_BYTES) return { ok: false, reason: "too_large", error: "The design is larger than 512 KiB." };
  if (!html.startsWith(DOCTYPE) || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    return { ok: false, reason: "not_a_document", error: "Publish one complete HTML document that starts with <!doctype html> and has <html> and <body>." };
  }
  const changed = html !== (await readDesign());
  const revision = (await listVersions()).length + 1;
  await mkdir(VERSIONS, { recursive: true });
  await writeFile(`${VERSIONS}/${revision}.html`, html);
  await writeFile(`${DESIGN}.tmp`, html);
  await rename(`${DESIGN}.tmp`, DESIGN);
  return { ok: true, revision, changed };
}

export const designTools: FxAgentHostTool[] = [
  {
    name: "read_design",
    description: "Read the current design HTML. Returns null before the first publish.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    idempotent: true,
    writes: false,
    async execute() {
      return { html: await readDesign(), revision: (await listVersions()).length };
    },
  },
  {
    name: "publish_design",
    description:
      "Publish one complete self-contained HTML document as the design. Use once for the first design or for a broad rewrite, and keep it under 12 KiB. Use edit_design for localized follow-ups.",
    inputSchema: {
      type: "object",
      properties: { html: { type: "string", description: "The complete self-contained HTML document." } },
      required: ["html"],
      additionalProperties: false,
    },
    idempotent: true,
    writes: true,
    async execute(input: { html: string }) {
      return save(input.html);
    },
  },
  {
    name: "edit_design",
    description:
      "Apply exact replacements to the current design in one call. They apply in order and publish once as one version. Each old_string must match exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Exact current text to replace once." },
              new_string: { type: "string", description: "Replacement text." },
            },
            required: ["old_string", "new_string"],
            additionalProperties: false,
          },
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
    idempotent: false,
    writes: true,
    async execute(input: { edits: { old_string: string; new_string: string }[] }) {
      let html = await readDesign();
      if (html === null) return { ok: false, reason: "no_design", error: "Publish a design before editing it." };
      for (const { old_string, new_string } of input.edits) {
        const at = html.indexOf(old_string);
        if (at === -1 || html.indexOf(old_string, at + 1) !== -1) {
          return { ok: false, reason: "no_unique_match", error: `old_string must match exactly once: ${old_string.slice(0, 80)}` };
        }
        html = html.slice(0, at) + new_string + html.slice(at + old_string.length);
      }
      return save(html);
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a public http(s) URL and return its text content, with scripts and styles stripped.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Public http(s) URL to fetch." } },
      required: ["url"],
      additionalProperties: false,
    },
    idempotent: true,
    writes: false,
    async execute(input: { url: string }, { signal }) {
      if (!/^https?:\/\//.test(input.url)) return { error: "only http(s) URLs are supported" };
      const response = await fetch(input.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      const text = (await response.text())
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { status: response.status, url: response.url, content: text.slice(0, 100 * 1024) };
    },
  },
];
