/* Any copyright is dedicated to the Public Domain. */
// ?api&url=... answers like archive.org's availability API; ?gone returns
// a 404; ?nocopy answers that there's no copy.
function handleRequest(request, response) {
  const query = request.queryString;
  if (query.startsWith("api")) {
    response.setHeader("Content-Type", "application/json");
    const none = decodeURIComponent(query).includes("nocopy");
    response.write(
      JSON.stringify(
        none
          ? { archived_snapshots: {} }
          : {
              archived_snapshots: {
                closest: {
                  available: true,
                  status: "200",
                  timestamp: "20240615120000",
                  url: "https://example.org/?archived",
                },
              },
            }
      )
    );
    return;
  }
  response.setStatusLine(request.httpVersion, query.includes("gone") || query.includes("nocopy") ? 404 : 200, "OK");
  response.setHeader("Content-Type", "text/html");
  response.write("<p>Page</p>");
}
