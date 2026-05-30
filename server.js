const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = process.env.PORT || 3000;
const host = process.env.HOST || "127.0.0.1";
const publicDir = path.join(__dirname, "public");
const rooms = new Map();
const trackedUsers = new Map();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roomTtlMs = 24 * 60 * 60 * 1000;
const maxRoomHtmlBytes = 2 * 1024 * 1024;
const emailRateWindowMs = 60 * 60 * 1000;
const maxEmailWritesPerEmailWindow = 5;
const maxEmailWritesPerRoomWindow = 60;
const frameCsp = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const appCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' about:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const securityHeaders = {
  "content-security-policy": appCsp,
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-frame-options": "DENY",
};
const urlAttributeNames = [
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "lowsrc",
  "poster",
  "src",
  "xlink:href",
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      html: "",
      comments: [],
      edits: [],
      clients: new Map(),
      expiresAt: null,
      expirationTimer: null,
    });
  }
  const room = rooms.get(id);
  if (isExpired(room)) {
    resetRoom(room);
  }
  return room;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders,
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function roomPresence(room) {
  return Array.from(room.clients.values()).map(({ id, name, color }) => ({
    id,
    name,
    color,
  }));
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return emailPattern.test(email) ? email : "";
}

function trackCommentEmail(room, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  if (!allowEmailTrackingWrite(room, normalized)) return;

  const now = new Date().toISOString();
  const existing = trackedUsers.get(normalized);
  trackedUsers.set(normalized, {
    createdAt: existing?.createdAt || now,
    lastSeen: now,
  });
}

function allowEmailTrackingWrite(room, email) {
  const now = Date.now();
  const windowStart = now - emailRateWindowMs;
  room.emailRateLimits ||= { room: [], emails: {} };
  room.emailRateLimits.room = pruneRateEvents(room.emailRateLimits.room, windowStart);
  room.emailRateLimits.emails[email] = pruneRateEvents(room.emailRateLimits.emails[email], windowStart);

  if (room.emailRateLimits.room.length >= maxEmailWritesPerRoomWindow || room.emailRateLimits.emails[email].length >= maxEmailWritesPerEmailWindow) {
    return false;
  }

  room.emailRateLimits.room.push(now);
  room.emailRateLimits.emails[email].push(now);
  return true;
}

function hasRoomContent(room) {
  return Boolean(room.html || room.comments.length || room.edits.length);
}

function isExpired(room) {
  return Boolean(room.expiresAt && Date.now() >= new Date(room.expiresAt).getTime());
}

function resetRoom(room) {
  room.html = "";
  room.comments = [];
  room.edits = [];
  room.expiresAt = null;
  if (room.expirationTimer) {
    clearTimeout(room.expirationTimer);
    room.expirationTimer = null;
  }
}

function ensureRoomExpiration(room) {
  if (!hasRoomContent(room) || room.expiresAt) return;
  room.expiresAt = new Date(Date.now() + roomTtlMs).toISOString();
  scheduleRoomExpiration(room);
}

function scheduleRoomExpiration(room) {
  if (room.expirationTimer) {
    clearTimeout(room.expirationTimer);
    room.expirationTimer = null;
  }
  if (!room.expiresAt) return;

  const delay = Math.max(0, new Date(room.expiresAt).getTime() - Date.now());
  room.expirationTimer = setTimeout(() => {
    resetRoom(room);
    broadcast(room, "html", { html: "", comments: [], edits: [] });
  }, delay);
}

function emit(client, event, data) {
  client.res.write(`event: ${event}\n`);
  client.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room, event, data, exceptId) {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) {
      emit(client, event, data);
    }
  }
}

function sanitizeDocumentHtml(html) {
  return ensureDocumentCsp(sanitizeHtmlFragment(html));
}

function sanitizeHtmlFragment(html) {
  let clean = String(html || "");
  clean = clean.replace(/<\s*(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  clean = clean.replace(/<\s*(script|iframe|object|embed|base|form)\b[^>]*\/?\s*>/gi, "");
  clean = clean.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?[^"'>\s]+["']?[^>]*>/gi, "");
  clean = clean.replace(/\s+on[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, "");
  clean = clean.replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi, "");
  clean = clean.replace(/\s+style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (_match, doubleQuoted, singleQuoted, bare) => {
    const safeStyle = sanitizeStyleValue(doubleQuoted || singleQuoted || bare || "");
    return safeStyle ? ` style="${escapeHtmlAttribute(safeStyle)}"` : "";
  });
  clean = clean.replace(/\s+srcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (match, doubleQuoted, singleQuoted, bare) => (
    isSafeSrcset(doubleQuoted || singleQuoted || bare || "") ? match : ""
  ));
  for (const name of urlAttributeNames) {
    const pattern = new RegExp(`\\s+(${name.replace(":", "\\:")})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "gi");
    clean = clean.replace(pattern, (match, _name, doubleQuoted, singleQuoted, bare) => (
      isSafeUrl(doubleQuoted || singleQuoted || bare || "") ? match : ""
    ));
  }
  return clean;
}

function ensureDocumentCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(frameCsp)}">`;
  const withoutExistingCsp = String(html || "").replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");

  if (/<head\b[^>]*>/i.test(withoutExistingCsp)) {
    return `<!doctype html>\n${withoutExistingCsp.replace(/<!doctype[^>]*>\s*/i, "").replace(/<head\b([^>]*)>/i, `<head$1>${meta}`)}`;
  }
  if (/<html\b[^>]*>/i.test(withoutExistingCsp)) {
    return `<!doctype html>\n${withoutExistingCsp.replace(/<!doctype[^>]*>\s*/i, "").replace(/<html\b([^>]*)>/i, `<html$1><head>${meta}</head>`)}`;
  }
  return `<!doctype html>\n<html><head>${meta}</head><body>${withoutExistingCsp}</body></html>`;
}

function sanitizeStyleValue(value) {
  const style = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!style) return "";
  if (/expression\s*\(/i.test(style) || /javascript\s*:/i.test(style) || /behavior\s*:/i.test(style) || /-moz-binding/i.test(style)) {
    return "";
  }
  const urls = style.match(/url\s*\(([^)]*)\)/gi) || [];
  for (const item of urls) {
    const rawUrl = item.replace(/^url\s*\(/i, "").replace(/\)$/i, "").trim().replace(/^['"]|['"]$/g, "");
    if (!isSafeStyleUrl(rawUrl)) return "";
  }
  return style;
}

function isSafeStyleUrl(value) {
  const url = normalizeUrlValue(value);
  return Boolean(url && (url.startsWith("#") || /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/i.test(url)));
}

function isSafeUrl(value) {
  const url = normalizeUrlValue(value);
  if (!url) return true;
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url.startsWith("?")) return true;
  if (/^(https?:|mailto:|tel:)/i.test(url)) return true;
  return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/i.test(url);
}

function isSafeSrcset(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter(Boolean)
    .every(isSafeUrl);
}

function normalizeUrlValue(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f\s]+/g, "").trim();
}

function pruneRateEvents(events, windowStart) {
  return Array.isArray(events) ? events.filter((timestamp) => Number(timestamp) > windowStart) : [];
}

function escapeHtmlAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, securityHeaders);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
      ...securityHeaders,
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/events") {
    const roomId = url.searchParams.get("room") || "lobby";
    const clientId = url.searchParams.get("client") || crypto.randomUUID();
    const color = url.searchParams.get("color") || "#2563eb";
    const name = url.searchParams.get("name") || "Anonymous";
    const room = getRoom(roomId);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...securityHeaders,
    });
    res.write("\n");

    const client = { id: clientId, name, color, res };
    room.clients.set(clientId, client);
    emit(client, "init", {
      room: roomId,
      html: room.html,
      comments: room.comments,
      edits: room.edits,
      clients: roomPresence(room),
    });
    broadcast(room, "presence", roomPresence(room));

    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      room.clients.delete(clientId);
      broadcast(room, "presence", roomPresence(room));
    });
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/api/rooms/")) {
    try {
      const parts = pathname.split("/").filter(Boolean);
      const roomId = parts[2];
      const action = parts[3];
      const room = getRoom(roomId);
      const body = await readJson(req);

      if (action === "html") {
        const html = String(body.html || "");
        if (Buffer.byteLength(html, "utf8") > maxRoomHtmlBytes) {
          sendJson(res, 413, { error: "HTML file is too large. Keep uploads under 2 MB." });
          return;
        }
        room.html = sanitizeDocumentHtml(html);
        room.comments = [];
        room.edits = [];
        room.expiresAt = new Date(Date.now() + roomTtlMs).toISOString();
        scheduleRoomExpiration(room);
        broadcast(room, "html", { html: room.html, comments: [], edits: [] });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "comment") {
        const author = String(body.author || "Anonymous").slice(0, 120);
        const comment = {
          id: body.id || crypto.randomUUID(),
          parentId: body.parentId || null,
          x: Number(body.x) || 0,
          y: Number(body.y) || 0,
          author,
          text: String(body.text || "").slice(0, 5000),
          createdAt: body.createdAt || new Date().toISOString(),
        };
        trackCommentEmail(room, comment.author);
        room.comments.push(comment);
        ensureRoomExpiration(room);
        broadcast(room, "comment", comment);
        sendJson(res, 200, { ok: true, comment });
        return;
      }

      if (action === "resolve-comment") {
        const commentId = String(body.id || "");
        room.comments.forEach((comment) => {
          if (comment.id === commentId || comment.parentId === commentId) {
            comment.resolved = true;
          }
        });
        ensureRoomExpiration(room);
        broadcast(room, "resolve-comment", { id: commentId });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "edit") {
        const edit = {
          id: body.id || crypto.randomUUID(),
          type: String(body.type || "text"),
          path: Array.isArray(body.path) ? body.path.map(Number) : [],
          paths: Array.isArray(body.paths) ? body.paths.map((path) => Array.isArray(path) ? path.map(Number) : []) : undefined,
          targetPath: Array.isArray(body.targetPath) ? body.targetPath.map(Number) : undefined,
          items: Array.isArray(body.items) ? body.items.slice(0, 200).map((item) => ({
            path: Array.isArray(item.path) ? item.path.map(Number) : undefined,
            html: typeof item.html === "string" ? sanitizeHtmlFragment(item.html.slice(0, 1024 * 1024)) : "",
          })) : undefined,
          html: typeof body.html === "string" ? sanitizeHtmlFragment(body.html.slice(0, 1024 * 1024)) : undefined,
          htmls: Array.isArray(body.htmls) ? body.htmls.slice(0, 200).map((html) => sanitizeHtmlFragment(String(html).slice(0, 1024 * 1024))) : undefined,
          text: String(body.text || ""),
          author: String(body.author || "Anonymous").slice(0, 80),
          createdAt: body.createdAt || new Date().toISOString(),
        };
        room.edits.push(edit);
        ensureRoomExpiration(room);
        broadcast(room, "edit", edit, body.clientId);
        sendJson(res, 200, { ok: true, edit });
        return;
      }

      if (action === "pointer") {
        const pointer = {
          clientId: String(body.clientId || ""),
          name: String(body.name || "Anonymous").slice(0, 80),
          color: String(body.color || "#2563eb"),
          x: Math.max(0, Math.min(1, Number(body.x) || 0)),
          y: Math.max(0, Math.min(1, Number(body.y) || 0)),
        };
        broadcast(room, "pointer", pointer, pointer.clientId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "presence") {
        const client = room.clients.get(String(body.clientId || ""));
        if (client) {
          client.name = String(body.name || client.name).slice(0, 80);
          client.color = String(body.color || client.color);
        }
        broadcast(room, "presence", roomPresence(room));
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: "Unknown room action" });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Bad request" });
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.listen(port, host, () => {
  console.log(`HTML Collab listening on http://${host}:${port}`);
});
