/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A tiny stand-in for Linear's GraphQL endpoint (https://api.linear.app/graphql).
// Every request is a POST with a JSON body; this fixture reads it to find
// the `team` filter the test sent and uses it as a scenario marker, the
// same trick whimsy_jira.sjs plays with its JQL string:
//   - no Authorization header, team != "SESSIONFAIL": a signed-in session
//     (the common case this fixture plays by default).
//   - no Authorization header, team == "SESSIONFAIL": a signed-out
//     session -- a GraphQL-shaped auth error, HTTP 200.
//   - an Authorization header matching VALID_KEY: the API-key fallback,
//     always succeeds regardless of the team marker.
//   - any other Authorization header: a rejected key, same auth error.
const VALID_KEY = "lin_api_test_key";

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

function authErrorBody() {
  return JSON.stringify({
    errors: [{ message: "Authentication required.", extensions: { code: "UNAUTHENTICATED" } }],
  });
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

function issuesBody(filter) {
  const nin = filter?.state?.type?.nin || [];
  return JSON.stringify({
    data: {
      viewer: {
        id: "viewer-1",
        assignedIssues: { nodes: ISSUES.filter(issue => !nin.includes(issue.state.type)) },
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
  const team = body?.variables?.filter?.team?.key?.eq || "";

  const authHeader = request.hasHeader("Authorization") ? request.getHeader("Authorization") : null;

  if (authHeader === null) {
    response.write(team === "SESSIONFAIL" ? authErrorBody() : issuesBody(body?.variables?.filter));
    return;
  }

  response.write(authHeader === VALID_KEY ? issuesBody(body?.variables?.filter) : authErrorBody());
}
