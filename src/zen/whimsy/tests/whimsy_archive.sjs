/* Any copyright is dedicated to the Public Domain. */
// ?api&url=... answers like archive.org's availability API and records the
// address it was asked about; ?gone returns a 404. ?nocopy (state) makes
// the API answer that there's no copy; ?lookups lists what it was asked;
// ?reset clears both.
function handleRequest(request, response) {
  const query = request.queryString;
  if (query == "reset") {
    setState("lookups", "");
    setState("mode", "");
    response.write("ok");
    return;
  }
  if (query == "nocopy") {
    setState("mode", "nocopy");
    response.write("ok");
    return;
  }
  if (query == "lookups") {
    response.setHeader("Content-Type", "text/plain");
    response.write(getState("lookups"));
    return;
  }
  if (query.startsWith("api")) {
    const asked = decodeURIComponent(query.replace(/^api&url=/, ""));
    setState("lookups", getState("lookups") + asked + "\n");
    response.setHeader("Content-Type", "application/json");
    const none = getState("mode") == "nocopy";
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
  response.setStatusLine(request.httpVersion, query.includes("gone") ? 404 : 200, "OK");
  response.setHeader("Content-Type", "text/html");
  response.write("<p>Page</p>");
}
