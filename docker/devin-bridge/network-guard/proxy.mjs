import http from "node:http";
import net from "node:net";
import fs from "node:fs";

const [host, portText] = (process.env.GUARD_LISTEN || "0.0.0.0:8080").split(":");
const port = Number(portText);
const suffixes = (process.env.GUARD_ALLOW_SUFFIXES || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const logPath = process.env.GUARD_LOG || "/tmp/egress.jsonl";

function allowed(hostname) {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return suffixes.some((suffix) => value === suffix.slice(1) || value.endsWith(suffix));
}

function audit(hostname, decision) {
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), hostname, decision })}\n`
  );
}

const server = http.createServer((req, res) => {
  const target = new URL(req.url);
  if (!allowed(target.hostname)) {
    audit(target.hostname, "deny");
    res.writeHead(403).end("egress denied\n");
    return;
  }
  audit(target.hostname, "allow");
  const upstream = http.request(target, { method: req.method, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  req.pipe(upstream);
  upstream.on("error", () => res.writeHead(502).end("upstream error\n"));
});

server.on("connect", (req, client, head) => {
  const [hostname, portValue] = req.url.split(":");
  if (!allowed(hostname)) {
    audit(hostname, "deny");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  audit(hostname, "allow");
  const upstream = net.connect(Number(portValue) || 443, hostname, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});

server.listen(port, host);
