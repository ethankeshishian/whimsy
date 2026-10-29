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

function issuesBody() {
  return JSON.stringify({
    data: {
      viewer: {
        id: "viewer-1",
        assignedIssues: {
          nodes: [
            {
              id: "issue-1",
              identifier: "ENG-1",
              title: "Fix the login bug",
              url: "https://linear.app/whimsy/issue/ENG-1",
              state: { name: "In Progress", type: "started" },
            },
            {
              id: "issue-2",
              identifier: "ENG-2",
              title: "Write the changelog",
              url: "https://linear.app/whimsy/issue/ENG-2",
              state: { name: "Todo", type: "unstarted" },
            },
          ],
        },
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
    response.write(team === "SESSIONFAIL" ? authErrorBody() : issuesBody());
    return;
  }

  response.write(authHeader === VALID_KEY ? issuesBody() : authErrorBody());
}
