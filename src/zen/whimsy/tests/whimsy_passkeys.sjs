/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// W26 passkeys: a relying party for browser_whimsy_passkeys.js. The page
// calls navigator.credentials.create/get and checks the answer itself
// (whimsy_passkeys_page.js).
function handleRequest(request, response) {
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  response.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Whimsy passkeys fixture</title>
    <script src="whimsy_passkeys_page.js"></script>
    </head><body><h1>Sign in to Whimsy test</h1>
    <input id="username" autocomplete="username webauthn">
    <p>Passkey fixture</p></body></html>`);
}
