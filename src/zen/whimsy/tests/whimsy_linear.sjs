/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A stand-in for both of Linear's GraphQL endpoints:
//
// - The session endpoint linear.app's web app uses
//   (client-api.linear.app/graphql): no Authorization header; the
//   signed-in state is the `whimsy_linear_session` cookie, and, like a
//   CSRF check, the Origin must be the page the test says the request is
//   made as (EXPECTED_ORIGIN, standing in for https://linear.app). The
//   `user` header picks the workspace, as on Linear. Cookie values:
//     (none)        signed out: AUTHENTICATION_ERROR, HTTP 400.
//     "solo"        one workspace.
//     "multi"       two workspaces, each with its own issues.
//     "locked"      two workspaces, the second answers FORBIDDEN.
//     "ratelimited" HTTP 400 RATELIMITED with X-RateLimit-Requests-Reset.
// - The public API (api.linear.app/graphql) with a personal API key in
//   the Authorization header: VALID_KEY works, anything else is rejected.
const VALID_KEY = "lin_api_test_key";
const EXPECTED_ORIGIN = "https://test1.example.com";
const COOKIE_NAME = "whimsy_linear_session";

function readBody(request) {
  const BinaryInputStream = Components.Constructor(
    "@mozilla.org/binaryinputstream;1",
    "nsIBinaryInputStream",
    "setInputStream"
  );
  const stream = new BinaryInputStream(request.bodyInputStream);
  let available = 0;
  const chunks = [];
  while ((available = stream.available()) > 0) {
    chunks.push(stream.readBytes(available));
  }
  return chunks.join("");
}

function header(request, name) {
  return request.hasHeader(name) ? request.getHeader(name) : null;
}

function sessionCookie(request) {
  const raw = header(request, "Cookie") || "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      return rest.join("=");
    }
  }
  return null;
}

function errorBody(code, message) {
  return JSON.stringify({ errors: [{ message, extensions: { code } }] });
}

// One issue per workflow state type, plus an older workspace's canceled
// state named "Duplicate". Like Linear, the server applies the
// state.type.nin filter the request carries.
const ISSUES = [
  ["issue-1", "ENG-1", "Fix the login bug", "In Progress", "started"],
  ["issue-2", "ENG-2", "Write the changelog", "Todo", "unstarted"],
  ["issue-3", "ENG-3", "Sort incoming reports", "Triage", "triage"],
  ["issue-4", "ENG-4", "Someday: dark mode", "Backlog", "backlog"],
  ["issue-5", "ENG-5", "Ship the release", "Done", "completed"],
  ["issue-6", "ENG-6", "Old idea", "Canceled", "canceled"],
  ["issue-7", "ENG-7", "Same as ENG-1", "Duplicate", "duplicate"],
  ["issue-8", "ENG-8", "Also same as ENG-1", "Duplicate", "canceled"],
].map(([id, identifier, title, name, type]) => ({
  id,
  identifier,
  title,
  url: `https://linear.app/whimsy/issue/${identifier}`,
  state: { name, type },
}));

const SIDE_ISSUES = [
  {
    id: "side-1",
    identifier: "SIDE-1",
    title: "Plan the side project",
    url: "https://linear.app/side/issue/SIDE-1",
    state: { name: "In Progress", type: "started" },
  },
];

const WORKSPACES = [
  { userId: "user-a", org: { id: "org-a", name: "Whimsy", urlKey: "whimsy" }, issues: ISSUES },
  { userId: "user-b", org: { id: "org-b", name: "Side Project", urlKey: "side" }, issues: SIDE_ISSUES },
];

function issuesBody(issues, filter) {
  const nin = filter?.state?.type?.nin || [];
  return JSON.stringify({
    data: {
      viewer: {
        id: "viewer-1",
        assignedIssues: { nodes: issues.filter(issue => !nin.includes(issue.state.type)) },
      },
    },
  });
}

function availableUsersBody(count) {
  return JSON.stringify({
    data: {
      availableUsers: {
        id: "account-1",
        users: WORKSPACES.slice(0, count).map(w => ({
          id: w.userId,
          active: true,
          organization: { ...w.org, deletionRequestedAt: null },
        })),
      },
    },
  });
}

function handleRequest(request, response) {
  response.setHeader("Content-Type", "application/json", false);

  let body = {};
  try {
    body = JSON.parse(readBody(request));
  } catch {
    body = {};
  }
  const filter = body?.variables?.filter;
  const isAvailableUsers = /availableUsers/.test(body?.query || "");

  // The public API with a personal key.
  const authHeader = header(request, "Authorization");
  if (authHeader !== null) {
    response.write(
      authHeader === VALID_KEY
        ? issuesBody(ISSUES, filter)
        : errorBody("AUTHENTICATION_ERROR", "Authentication required, not authenticated")
    );
    return;
  }

  // The session endpoint.
  const session = sessionCookie(request);
  if (!session || header(request, "Origin") !== EXPECTED_ORIGIN || !header(request, "Linear-Client-ID")) {
    response.setStatusLine(request.httpVersion, 400, "Bad Request");
    response.write(errorBody("AUTHENTICATION_ERROR", "Authentication required, not authenticated"));
    return;
  }
  if (session === "ratelimited") {
    response.setStatusLine(request.httpVersion, 400, "Bad Request");
    response.setHeader("X-RateLimit-Requests-Reset", String(Date.now() + 10 * 60 * 1000), false);
    response.write(errorBody("RATELIMITED", "Rate limit exceeded"));
    return;
  }
  const count = session === "solo" ? 1 : 2;
  if (isAvailableUsers) {
    response.write(availableUsersBody(count));
    return;
  }
  const userId = header(request, "user");
  const workspace = WORKSPACES.slice(0, count).find(w => w.userId === userId);
  if (!workspace || header(request, "userAccount") !== "account-1") {
    response.setStatusLine(request.httpVersion, 400, "Bad Request");
    response.write(errorBody("INVALID_INPUT", "Unknown user"));
    return;
  }
  if (session === "locked" && workspace.userId === "user-b") {
    response.setStatusLine(request.httpVersion, 403, "Forbidden");
    response.write(errorBody("FORBIDDEN", "This workspace requires SAML sign-in"));
    return;
  }
  response.write(issuesBody(workspace.issues, filter));
}
