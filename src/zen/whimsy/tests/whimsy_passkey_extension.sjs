/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

function handleRequest(request, response) {
  const params = new URLSearchParams(request.queryString);
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  if (params.has("coop")) {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups", false);
  }
  if (params.has("csp")) {
    response.setHeader("Content-Security-Policy", "script-src 'self'", false);
  }
  response.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Passkey extension interception</title>
    <script src="whimsy_passkey_extension_page.js"></script>`);
  if (params.has("early")) {
    response.write(`<script>window.earlyCredential = window.requestCredential("get");</script>`);
  }
  if (params.has("csp")) {
    response.write(`<script>window.inlineScriptRan = true;</script>`);
  }
  response.write(`</head><body><button id="popup">Sign in</button><p>Passkey fixture</p>`);
  if (params.has("frame")) {
    response.write(`<iframe id="credential-frame" allow="publickey-credentials-get"
      src="https://example.org${request.path}?child"></iframe>`);
  }
  response.write(`</body></html>`);
}
