import { DESIGN_ARTIFACT_EMBEDDED_CSP, prepareDesignArtifactHtml } from '../../../lib/design-artifact'
import { readDesignHtml } from '../../../lib/chats'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const { html: artifact, past } = await readDesignHtml(params.get('session'), params.get('revision'))
  const readyToken = crypto.randomUUID()
  const prepared = artifact == null ? null : prepareDesignArtifactHtml(artifact, DESIGN_ARTIFACT_EMBEDDED_CSP, readyToken)
  // Every stored design passed validation, so this only guards against one that
  // somehow lacks a doctype: it is never shown without its CSP.
  if (artifact != null && prepared == null) console.error('[fx0] artifact:unrenderable', { session: params.get('session'), revision: params.get('revision') })
  const preparedArtifact = prepared ??
    `<!doctype html><html><head><meta charset="utf-8"><title>No design artifact</title></head><body><p>${
      artifact != null ? 'This design could not be prepared for preview.'
        : past ? 'This version is not in the history.' : 'No design artifact has been published for this session.'
    }</p></body></html>`
  const artifactUrl = `data:text/html;base64,${Buffer.from(preparedArtifact, 'utf8').toString('base64')}`
  const csp = [
    "default-src 'none'",
    'frame-src data:',
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
  const serializedArtifactUrl = JSON.stringify(artifactUrl)
  const serializedReadyToken = JSON.stringify(readyToken)
  // The wrapper paints nothing of its own, so a design that has not painted yet
  // shows the app's background. Sharing the app's color scheme keeps it
  // transparent; a design that sets no background still gets the browser's white.
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design artifact preview</title>
<style>:root{color-scheme:light dark}html,body,#frame-root,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style>
</head>
<body>
<div id="frame-root"></div>
<script>
const artifact=${serializedArtifactUrl};
const token=${serializedReadyToken};
const frame=document.createElement('iframe');
frame.title='Interactive design artifact';
frame.setAttribute('sandbox','allow-scripts');
frame.referrerPolicy='no-referrer';
frame.setAttribute('credentialless','');
let readySignals=0;
let consumedSignals=0;
let lastHeartbeat=Date.now();
const restore=()=>{lastHeartbeat=Date.now();frame.src=artifact;};
addEventListener('message',event=>{
  if(event.source!==frame.contentWindow||event.data?.token!==token)return;
  lastHeartbeat=Date.now();
  if(event.data.type==='ready')readySignals++;
  // The design paints in its own process, after this wrapper's load event; the app
  // swaps a new revision on screen only once it has.
  if(event.data.type==='painted')parent.postMessage({type:'fx0-artifact-painted'},location.origin);
  // The design can only ask to open a link: its scripts can read the token and send
  // this at any time. The app shows the address and opens it on the user's own click
  // there. Recent user activation only filters out asks nobody prompted; it is not proof.
  if(event.data.type==='open'&&typeof event.data.url==='string'&&navigator.userActivation?.isActive!==false){
    parent.postMessage({type:'fx0-artifact-open',url:event.data.url},location.origin);
  }
});
frame.addEventListener('load',()=>setTimeout(()=>{
  if(readySignals>consumedSignals){consumedSignals=readySignals;return;}
  restore();
},100));
setInterval(()=>{
  if(document.visibilityState==='visible'&&Date.now()-lastHeartbeat>3000)restore();
},500);
frame.src=artifact;
document.querySelector('#frame-root').append(frame);
</script>
</body>
</html>`
  return new Response(html, {
    status: artifact == null ? 404 : 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-security-policy': csp,
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy':
        'accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}
