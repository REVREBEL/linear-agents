/**
 * Shared GitHub App homepage for all LinearBridge agent Workers.
 * Use at GET / on github-<agent> custom domains.
 */
export function githubAppHomePage(agent: string): Response {
  const safeAgent = /^[a-z][a-z0-9-]*$/.test(agent) ? agent : "agent";
  const appName = `rebel-${safeAgent}`;
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${appName} | REVREBEL</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#101c32;color:#fafafa;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(100%,560px);padding:48px 40px;border:1px solid #365075;border-radius:18px;background:#163666}
header{font-size:13px;letter-spacing:.16em;font-weight:700;color:#71c9c5}h1{font-size:clamp(28px,5vw,40px);line-height:1.2;letter-spacing:-.035em;margin:20px 0}p{color:#d9e6f4}
small{display:block;margin-top:34px;color:#a9bfd9}a{color:#b9f5ef}
</style></head><body><main><header>REVREBEL · GITHUB INTEGRATION</header><h1>${appName}</h1>
<p>GitHub App integration for the REVREBEL LinearBridge agent system.</p>
<p>This service processes authenticated GitHub events and supports agent workflows. Webhook endpoints are not intended for browser access.</p>
<small>Integration: ${safeAgent} · <a href="https://github.com/REVREBEL">REVREBEL on GitHub</a></small>
</main></body></html>`;
  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
