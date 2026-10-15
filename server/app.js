"use strict";
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { PERMISSIONS } = require("../chaincode/lib/domain");
const PUBLIC = resolve(__dirname, "../public");
const FILES = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
  "/mark.svg": ["mark.svg", "image/svg+xml"],
};
const STATUS = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CAPACITY: 409,
};
function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function authenticate(req, tokens) {
  const match = (req.headers.authorization || "").match(
    /^Bearer ([A-Za-z0-9_-]{32,256})$/,
  );
  if (!match) return null;
  const value = match[1];
  const bytes = Buffer.from(value);
  for (const [role, token] of Object.entries(tokens)) {
    const expected = Buffer.from(token);
    if (bytes.length === expected.length && timingSafeEqual(bytes, expected))
      return role;
  }
  return null;
}
async function body(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json"))
    throw new Error("VALIDATION: Use application/json");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error("VALIDATION: Request exceeds 32 KiB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error("VALIDATION: Invalid JSON");
  }
}
function errorDetails(error) {
  const detail = [
    error.message,
    ...(Array.isArray(error.details)
      ? error.details.map((item) => item.message || "")
      : []),
  ].join(" ");
  const match = detail.match(
    /\b(VALIDATION|FORBIDDEN|NOT_FOUND|CONFLICT|CAPACITY): ([^\n]+)/,
  );
  if (match)
    return {
      status: STATUS[match[1]],
      code: match[1],
      message: match[2].slice(0, 300),
    };
  if (/MVCC_READ_CONFLICT|PHANTOM_READ_CONFLICT/.test(detail))
    return {
      status: 409,
      code: "CONFLICT",
      message:
        "Another operation changed this equipment. Refresh before retrying.",
    };
  return {
    status: 503,
    code: "LEDGER_UNAVAILABLE",
    message:
      "Ledger unavailable or transaction outcome uncertain. Refresh, then retry with the same idempotency key.",
  };
}
function createApp({ ledger, tokens, publicOrigin, logger = console }) {
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/health")
        return send(res, 200, { status: "ready", mode: ledger.mode });
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" || !Object.hasOwn(FILES, url.pathname))
          return send(res, 404, { error: "NOT_FOUND" });
        const [file, type] = FILES[url.pathname];
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        return res.end(await readFile(resolve(PUBLIC, file)));
      }
      const address = req.socket.remoteAddress;
      const now = Date.now();
      // Bounded, per-connection-address failure tracking. Do not trust forwarded headers.
      if (attempts.size >= 10000)
        for (const [key, entry] of attempts)
          if (entry.until <= now) attempts.delete(key);
      const entry = attempts.get(address);
      if (!entry && attempts.size >= 10000)
        return send(res, 429, {
          error: "RATE_LIMITED",
          message: "Access is temporarily rate limited.",
        });
      if (entry && entry.until > now && entry.count >= 30)
        return send(res, 429, {
          error: "RATE_LIMITED",
          message: "Too many failed access attempts; wait one minute.",
        });
      const role = authenticate(req, tokens);
      if (!role) {
        const next =
          entry && entry.until > now ? entry : { count: 0, until: now + 60000 };
        next.count++;
        attempts.set(address, next);
        return send(res, 401, {
          error: "UNAUTHORIZED",
          message: "Enter a valid staff access key.",
        });
      }
      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        const data = await ledger.snapshot(role);
        return send(res, 200, {
          ...data,
          meta: {
            mode: ledger.mode,
            role,
            serverTime: new Date().toISOString(),
            businessName: "Chagrin River Kayak and Paddleboard",
            timezone: "America/New_York",
          },
        });
      }
      const history = url.pathname.match(
        /^\/api\/assets\/([A-Za-z0-9_-]{2,64})\/history$/,
      );
      if (req.method === "GET" && history)
        return send(
          res,
          200,
          await ledger.history(
            history[1],
            url.searchParams.get("cursor") || "",
            role,
          ),
        );
      const rental = url.pathname.match(
        /^\/api\/rentals\/([A-Za-z0-9_-]{2,64})$/,
      );
      if (req.method === "GET" && rental)
        return send(res, 200, await ledger.rental(rental[1], role));
      if (req.method === "POST" && url.pathname === "/api/transactions") {
        const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== expectedOrigin)
          return send(res, 403, {
            error: "FORBIDDEN",
            message: "Origin is not allowed.",
          });
        const data = await body(req);
        if (
          !data ||
          typeof data !== "object" ||
          Object.keys(data).some(
            (key) => !["action", "payload"].includes(key),
          ) ||
          !Object.hasOwn(PERMISSIONS, data.action)
        )
          return send(res, 400, {
            error: "VALIDATION",
            message: "Unknown action or request field.",
          });
        if (!PERMISSIONS[data.action].includes(role))
          return send(res, 403, {
            error: "FORBIDDEN",
            message: "Your role cannot perform this operation.",
          });
        const requestId = req.headers["idempotency-key"];
        if (
          typeof requestId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(requestId)
        )
          return send(res, 400, {
            error: "VALIDATION",
            message:
              "Supply an Idempotency-Key header (2–64 letters, digits, dashes or underscores).",
          });
        return send(
          res,
          200,
          await ledger.execute(data.action, data.payload, requestId, role),
        );
      }
      return send(res, 404, {
        error: "NOT_FOUND",
        message: "Endpoint not found.",
      });
    } catch (error) {
      const details = errorDetails(error);
      if (details.status >= 500)
        logger.error("Ledger request failed:", error.name || "Error");
      if (!res.headersSent)
        send(res, details.status, {
          error: details.code,
          message: details.message,
        });
      else res.end();
    }
  });
  server.requestTimeout = 90000;
  server.headersTimeout = 15000;
  return server;
}
module.exports = { createApp, errorDetails };
