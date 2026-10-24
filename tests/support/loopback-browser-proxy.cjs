// Browser tests bypass this proxy only for loopback. Every proxied request is
// denied before any target connection; receipts record authority, never bodies.
const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.env.YZT_BROWSER_PROXY_PORT || 5299);
const log = process.env.YZT_BROWSER_PROXY_LOG;
if (!log || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Explicit browser network log and valid port required");
const descriptor = fs.openSync(log, "wx");
function deny(kind, value) {
  let authority = "invalid-target";
  try { authority = new URL(kind === "connect" ? "http://" + value : value).host; } catch {}
  fs.writeSync(descriptor, JSON.stringify({ at: new Date().toISOString(), kind, authority }) + "\n");
}
const server = http.createServer((request, response) => {
  deny("http", request.url);
  response.writeHead(403);
  response.end("BROWSER_TEST_EXTERNAL_NETWORK_DENIED");
});
server.on("connect", (request, socket) => {
  deny("connect", request.url);
  socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
server.listen(port, "127.0.0.1", () => console.log("Browser deny proxy ready on " + port));
