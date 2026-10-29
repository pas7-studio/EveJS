"use strict";
// A plain HTTP/1.1 content host for the flatbuffer catalogues our server publishes.
//
// Why it exists: the client's content provider is Python 2 httplib - `HTTPSConnection(host, 443)`
// plus a GET - so it speaks HTTP/1.1, while port 443 on this machine is the HTTP/2 gRPC gateway
// (and that listener must not gain a request handler: Node's compat layer then sends trailers
// after grpc-status and kills the process). This server is a separate object on its own address,
// so it answers a plain GET without touching the gateway.
//
// It serves exactly the routes `getGatewayBinaryAsset` knows (the title catalogue and the map
// tags file) and answers 404 for everything else - it is a content host, not a second gateway.
const https = require("https");

function createContentRequestHandler(resolveAsset) {
  return (req, res) => {
    const method = String(req.method || "").toUpperCase();
    const routePath = String(req.url || "/");
    const asset = method === "GET" ? resolveAsset(routePath) : null;
    if (!asset) {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "content-type": asset.contentType || "application/octet-stream",
      "content-length": asset.buffer.length,
      "cache-control": "no-store",
    });
    res.end(asset.buffer);
  };
}

// "127.0.0.2:443" or just a port. Anything unusable returns null instead of guessing.
function parseBind(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const split = text.lastIndexOf(":");
  if (split < 0) {
    const port = Number(text);
    return Number.isInteger(port) && port > 0 ? { host: "127.0.0.1", port } : null;
  }
  const host = text.slice(0, split) || "127.0.0.1";
  const port = Number(text.slice(split + 1));
  return Number.isInteger(port) && port > 0 ? { host, port } : null;
}

function createContentCdnServer({ tlsOptions, resolveAsset, bind, log = console } = {}) {
  const target = parseBind(bind);
  if (!target) return null;
  const server = https.createServer(tlsOptions, createContentRequestHandler(resolveAsset));
  server.on("error", (err) => {
    log.error(`content CDN server failed on ${target.host}:${target.port}: ${err.message}`);
  });
  server.listen(target.port, target.host, () => {
    log.log(`content CDN server listening on ${target.host}:${target.port}`);
  });
  return server;
}

module.exports = {
  createContentCdnServer,
  createContentRequestHandler,
  parseBind,
};
