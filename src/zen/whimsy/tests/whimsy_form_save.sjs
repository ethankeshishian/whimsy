/* Any copyright is dedicated to the Public Domain. */
// W13-R1: the autosave and submit endpoint. ?save and ?submit count a
// request; ?count answers how many saves arrived; ?reset clears.
function handleRequest(request, response) {
  const query = request.queryString;
  response.setHeader("Cache-Control", "no-store");
  if (query == "reset") {
    setState("saves", "0");
    response.write("ok");
    return;
  }
  if (query == "count") {
    response.setHeader("Content-Type", "text/plain");
    response.write(getState("saves") || "0");
    return;
  }
  if (query == "save" || query == "submit") {
    setState("saves", String(Number(getState("saves") || "0") + 1));
    response.setHeader("Content-Type", "text/html");
    response.write("<!DOCTYPE html><title>Saved</title>saved");
    return;
  }
  response.setStatusLine(request.httpVersion, 404, "Not Found");
}
