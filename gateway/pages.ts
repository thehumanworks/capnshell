/** The gateway's HTML: the page a connector's sign-in opens, which waits for an owner's approval. */

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const style = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #fafafa; --card: #fff; --line: #ddd; --accent: #0b57d0; --warn: #8a4b00; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a0a0a0; --bg: #161616; --card: #1f1f1f; --line: #333; --accent: #8ab4f8; --warn: #f6b26b; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 12px; }
p { margin: 8px 0; }
.muted { color: var(--muted); font-size: 14px; }
.warn { color: var(--warn); }
.code { font: 600 32px/1.2 ui-monospace, monospace; letter-spacing: 2px; margin: 16px 0 8px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 14px; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
#state { font-weight: 600; }
`;

export interface ConsentPage {
  code: string;
  handle: string;
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  loopback: boolean;
  nonce: string;
  minutes: number;
}

/**
 * The page shows the code to approve and polls /authorize/wait with its handle; once an owner
 * runs `cns gateway approve CODE` on one of their devices, it follows the redirect to the client.
 */
export function consentPage(page: ConsentPage): string {
  const name = escape(page.clientName);
  const origin = page.clientDomain
    ? `Published by <strong>${escape(page.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve connector</title><style>${style}</style></head>
<body><main><div class="card">
<h1>Approve ${name}?</h1>
<p>${origin} If you approve it, its access goes to <strong>${escape(page.redirectHost)}</strong>.</p>
${page.loopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<p>To let it use your devices through this gateway, run this on one of your devices that owns the gateway:</p>
<div class="code">${escape(page.code)}</div>
<pre>cns gateway approve ${escape(page.code)}</pre>
<p class="muted">cns shows the app's name and where its access goes before it asks you; check that they match this page. The code works for ${page.minutes} minutes, only from this page.</p>
<p id="state">Waiting for approval...</p>
<p><button id="cancel" type="button">Cancel</button></p>
</div></main>
<script nonce="${escape(page.nonce)}">
const body = JSON.stringify({ code: ${JSON.stringify(page.code)}, handle: ${JSON.stringify(page.handle)} });
const state = document.getElementById("state");
let done = false;
async function ask(path) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body, credentials: "same-origin" });
  return await response.json();
}
function finish(answer) {
  if (answer.redirectTo) { done = true; state.textContent = answer.status === "approved" ? "Approved. Returning to the app..." : "Declined."; location.href = answer.redirectTo; return true; }
  if (answer.status === "expired") { done = true; state.textContent = "This page has expired. Start connecting again from the app."; return true; }
  return false;
}
async function poll() {
  if (done) return;
  try { if (finish(await ask("/authorize/wait"))) return; } catch { /* Try again. */ }
  setTimeout(poll, 2000);
}
document.getElementById("cancel").addEventListener("click", async () => { if (!done) finish(await ask("/authorize/cancel")); });
poll();
</script></body></html>`;
}

/** A page that only says something went wrong; never a redirect, since the client may not be trusted. */
export function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connector error</title><style>${style}</style></head><body><main><div class="card"><h1>This connection cannot continue</h1><p>${escape(message)}</p></div></main></body></html>`;
}

/** Content-Security-Policy for the consent page: its own script, its own requests, no framing. */
export function consentPolicy(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}
