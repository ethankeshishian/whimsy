/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Runs in the page, with its CSP. No privileged/Xray navigator and no eval.
window.requestCredential = async function (method, conditional = false) {
  const controller = new AbortController();
  // A missed hook must terminate rather than leave native WebAuthn pending.
  const timer = setTimeout(() => controller.abort(), 2000);
  const publicKey = method == "get" ? {
    challenge: new Uint8Array(32),
    allowCredentials: [],
    userVerification: "discouraged",
    timeout: 2000,
  } : {
    challenge: new Uint8Array(32),
    rp: { name: "Whimsy test" },
    user: { id: new Uint8Array([1]), name: "test", displayName: "Test" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: 2000,
  };
  try {
    const credential = await navigator.credentials[method]({
      publicKey,
      signal: controller.signal,
      ...(conditional ? { mediation: "conditional" } : {}),
    });
    return { id: credential?.id ?? null, error: null };
  } catch (error) {
    return { id: null, error: error.name };
  } finally {
    clearTimeout(timer);
  }
};

addEventListener("DOMContentLoaded", () => {
  document.getElementById("popup").addEventListener("click", () => {
    window.open(window.passkeyPopupURL, "", "width=440,height=500");
  });
});
