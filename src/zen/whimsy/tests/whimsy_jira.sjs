/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A tiny stand-in for Jira Cloud's `/rest/api/2/search`. A JQL containing
// "unauth" answers like a signed-out Jira site (401); anything else
// answers with fixed issues: To Do, In Progress and Done. Like Jira, a
// "statusCategory not in (...)" clause leaves out those categories' ids.
function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  const query = decodeURIComponent(request.queryString.replace(/\+/g, " "));
  response.setHeader("Content-Type", "application/json", false);

  if (query.includes("unauth")) {
    response.setStatusLine(request.httpVersion, 401, "Unauthorized");
    response.write(JSON.stringify({ errorMessages: ["Unauthorized"] }));
    return;
  }

  const issues = [
    ["ABC-1", "Fix the login bug", "In Progress", "indeterminate", 4],
    ["ABC-2", "Write the changelog", "To Do", "new", 2],
    ["ABC-3", "Ship the release", "Done", "done", 3],
  ];
  const notIn = /statusCategory not in \(([^)]*)\)/.exec(query);
  const excluded = notIn ? notIn[1].split(",").map(id => Number(id.trim())) : [];
  response.write(
    JSON.stringify({
      issues: issues
        .filter(([, , , , id]) => !excluded.includes(id))
        .map(([key, summary, name, categoryKey, id]) => ({
          key,
          fields: { summary, status: { name, statusCategory: { id, key: categoryKey } } },
        })),
    })
  );
}
