/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A sign-in page shaped like Google's: a nonce + strict-dynamic script
// policy with Trusted Types, so only the page's own nonced script runs.
function handleRequest(request, response) {
  const params = new URLSearchParams(request.queryString);
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  if (params.has("strict")) {
    response.setHeader("Content-Security-Policy",
      "script-src 'nonce-whimsytest' 'strict-dynamic' 'unsafe-eval'; " +
      "object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'", false);
  }
  response.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Passkey bridge</title>
    <script nonce="whimsytest" src="whimsy_passkey_extension_page.js"></script>
    </head><body><button id="popup" hidden>Sign in</button><p>Use your passkey to confirm it's really you</p></body></html>`);
}
