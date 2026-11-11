/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// Deliberately lacks an image extension: native image drag metadata must survive
// RemoteDropLinks, rather than treating every image as a filename suffix.
function handleRequest(request, response) {
  response.setHeader("Content-Type", "image/png", false);
  response.setHeader("Cache-Control", "no-store", false);
  response.write(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwaDjwHwAFBAKAPJ4DgAAAAABJRU5ErkJggg=="));
}
