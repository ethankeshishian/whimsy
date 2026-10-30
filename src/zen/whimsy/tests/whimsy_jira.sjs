/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A tiny stand-in for Jira Cloud's `/rest/api/2/search`. A JQL containing
// "unauth" answers like a signed-out Jira site (401); anything else
// answers with two fixed issues.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  const query = decodeURIComponent(request.queryString);
  response.setHeader("Content-Type", "application/json", false);

  if (query.includes("unauth")) {
    response.setStatusLine(request.httpVersion, 401, "Unauthorized");
    response.write(JSON.stringify({ errorMessages: ["Unauthorized"] }));
    return;
  }

  response.write(
    JSON.stringify({
      issues: [
        { key: "ABC-1", fields: { summary: "Fix the login bug", status: { name: "In Progress" } } },
        { key: "ABC-2", fields: { summary: "Write the changelog", status: { name: "To Do" } } },
      ],
    })
  );
}
