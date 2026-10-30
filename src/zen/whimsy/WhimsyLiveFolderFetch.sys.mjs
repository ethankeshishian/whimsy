/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A POST-capable counterpart to nsZenLiveFolderProvider's own fetch()
// (GET-only: Jira, GitHub and RSS never needed a body). Linear's GraphQL
// endpoint takes every query as a POST with a JSON body, so this builds
// its own upload channel -- same cookie/userContextId setup as the base
// class's fetch(), same response-reading loop as
// WhimsyLiveFolders.sys.mjs's conditionalFetch() -- just with a request
// body attached. Lives here, not in ZenLiveFolder.sys.mjs, since that's a
// Zen file Whimsy never edits; any future Whimsy live folder that needs a
// POST should import this instead of growing its own copy.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

/**
 * The container (userContextId) a live folder's requests run as: the one
 * its space uses, exactly like the base class's own fetch(). With Space
 * Profiles a space's profile *is* its container (workspace.containerTabId),
 * so this also picks the profile's cookies.
 *
 * @param {object} liveFolder - a nsZenLiveFolderProvider instance.
 * @returns {number}
 */
export function whimsyLiveFolderUserContextId(liveFolder) {
  try {
    const folder = liveFolder?.manager?.getFolderForLiveFolder?.(liveFolder);
    if (folder) {
      const space = folder.documentGlobal.gZenWorkspaces.getWorkspaceFromId(
        folder.getAttribute("zen-workspace-id")
      );
      if (space) {
        return Number(space.containerTabId) || 0;
      }
    }
  } catch {
    // No real folder behind this provider (e.g. a test double): the
    // default container is the right fallback.
  }
  return 0;
}

/**
 * @param {object} liveFolder - a nsZenLiveFolderProvider instance (or any
 *   object with a `.manager.getFolderForLiveFolder`), used only to
 *   resolve the folder's container (userContextId), exactly like the
 *   base class's own fetch().
 * @param {string} url
 * @param {object} options
 * @param {string} options.body - the raw request body, already serialized.
 * @param {string} [options.contentType]
 * @param {object} [options.headers] - extra request headers (e.g. Authorization).
 * @param {string} [options.principalURL] - the site the request is made
 *   as (its Origin header and SameSite context). Defaults to `url`
 *   itself. Linear's session path sets https://linear.app, the page its
 *   own web app runs on, for a request to client-api.linear.app.
 * @param {number} [options.maxContentLength]
 * @returns {Promise<{text: string, status: number|null, header: (name: string) => string|null}>}
 */
export function whimsyPostFetch(
  liveFolder,
  url,
  {
    body,
    contentType = "application/json",
    headers = {},
    principalURL = null,
    maxContentLength = 5 * 1024 * 1024,
  } = {}
) {
  const uri = lazy.NetUtil.newURI(url);

  // A live folder that lives in a container space sends its request (and
  // therefore its cookies) as that container, never the default one.
  const userContextId = whimsyLiveFolderUserContextId(liveFolder);

  const principal = Services.scriptSecurityManager.createContentPrincipal(
    principalURL ? lazy.NetUtil.newURI(principalURL) : uri,
    { userContextId }
  );

  const channel = lazy.NetUtil.newChannel({
    uri,
    // See ZenLiveFolder.sys.mjs's own fetch() for why TYPE_SAVEAS_DOWNLOAD:
    // it's what makes the provided principal (and therefore its cookies)
    // actually apply.
    contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
    loadingPrincipal: principal,
    securityFlags:
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE,
    triggeringPrincipal: principal,
  }).QueryInterface(Ci.nsIHttpChannel);

  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
  stream.setUTF8Data(body ?? "");
  channel.QueryInterface(Ci.nsIUploadChannel2).explicitSetUploadStream(stream, contentType, -1, "POST");

  for (const [name, value] of Object.entries(headers)) {
    if (value != null) {
      channel.setRequestHeader(name, String(value), false);
    }
  }

  let httpStatus = null;
  // Response headers are read on demand (e.g. a rate limit's reset time);
  // nothing here ever reads or keeps the request's cookies.
  const header = name => {
    try {
      return channel.getResponseHeader(name);
    } catch {
      return null;
    }
  };
  const byteChunks = [];
  let totalLength = 0;

  const { promise, resolve, reject } = Promise.withResolvers();

  channel.asyncOpen({
    onDataAvailable: (request, stream2, _offset, count) => {
      totalLength += count;
      if (totalLength > maxContentLength) {
        request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
      } else {
        byteChunks.push(lazy.NetUtil.readInputStream(stream2, count));
      }
    },
    onStartRequest: request => {
      try {
        httpStatus = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
      } catch {
        httpStatus = null;
      }
    },
    onStopRequest: (_request, status) => {
      if (!Components.isSuccessCode(status)) {
        reject(Components.Exception("Failed to fetch document", status));
        return;
      }

      const bytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of byteChunks) {
        bytes.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }

      resolve({ text: new TextDecoder("utf-8").decode(bytes), status: httpStatus, header });
    },
  });

  return promise;
}
