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
const dangerousElements = new Set(["script", "iframe", "object", "embed", "base", "form"]);
const urlAttributeNames = new Set([
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
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/events" || url.pathname.startsWith("/api/rooms/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: securityHeaders(corsHeaders(request)),
        });
      }

      const roomId = roomIdFromRequest(url);
      const id = env.ROOMS.idFromName(roomId);
      return withCors(await env.ROOMS.get(id).fetch(request), request);
    }

    if (url.hostname === "www.pairhtml.com") {
      url.hostname = "pairhtml.com";
      url.protocol = "https:";
      return new Response(null, {
        status: 308,
        headers: {
          location: url.toString(),
          ...securityHeaders(corsHeaders(request)),
        },
      });
    }

    return hardenResponse(await env.ASSETS.fetch(request));
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.room = null;
    this.scheduledExpiresAt = null;
    this.loadPromise = this.loadRoom();
  }

  async fetch(request) {
    await this.loadPromise;

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/events") {
      return this.handleEvents(request, url);
    }

    if (request.method === "POST" && pathname.startsWith("/api/rooms/")) {
      try {
        const parts = pathname.split("/").filter(Boolean);
        const action = parts[3];
        const body = await readJson(request);
        return await this.handleAction(action, body);
      } catch (error) {
        return sendJson(error.status || 400, { error: error.message || "Bad request" });
      }
    }

    return sendJson(404, { error: "Not found" });
  }

  async loadRoom() {
    this.room = await this.state.storage.get("room");
    if (!this.room) {
      this.room = emptyRoom();
      return;
    }

    if (isExpired(this.room)) {
      await this.resetRoom();
      return;
    }

    if (hasRoomContent(this.room) && !this.room.expiresAt) {
      this.room.expiresAt = new Date(Date.now() + roomTtlMs).toISOString();
      await this.saveRoom();
    }
  }

  async saveRoom() {
    if (hasRoomContent(this.room) && !this.room.expiresAt) {
      this.room.expiresAt = new Date(Date.now() + roomTtlMs).toISOString();
    }

    await this.state.storage.put("room", {
      html: this.room.html,
      fileName: this.room.fileName || "",
      comments: this.room.comments,
      edits: this.room.edits,
      expiresAt: this.room.expiresAt || null,
    });

    await this.scheduleExpiration();
  }

  async resetRoom() {
    this.room = emptyRoom();
    this.scheduledExpiresAt = null;
    await this.state.storage.deleteAll();
  }

  async scheduleExpiration() {
    if (!this.room.expiresAt) {
      if (!this.scheduledExpiresAt) return;
      await this.state.storage.deleteAlarm();
      this.scheduledExpiresAt = null;
      return;
    }

    if (this.scheduledExpiresAt === this.room.expiresAt) return;
    await this.state.storage.setAlarm(new Date(this.room.expiresAt).getTime());
    this.scheduledExpiresAt = this.room.expiresAt;
  }

  async alarm() {
    await this.loadPromise;
    if (!isExpired(this.room)) {
      await this.scheduleExpiration();
      return;
    }

    await this.resetRoom();
    this.broadcast("html", { html: "", fileName: "", comments: [], edits: [] });
  }

  handleEvents(request, url) {
    const roomId = url.searchParams.get("room") || "lobby";
    const clientId = url.searchParams.get("client") || crypto.randomUUID();
    const client = {
      id: clientId,
      name: String(url.searchParams.get("name") || "Anonymous").slice(0, 120),
      color: String(url.searchParams.get("color") || "#2563eb"),
    };
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();

    client.send = (event, data) => {
      return writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };
    client.ping = () => writer.write(encoder.encode(": ping\n\n"));
    client.close = () => writer.close().catch(() => {});
    this.clients.set(clientId, client);

    let heartbeat;
    client.ping().catch(() => this.removeClient(clientId, heartbeat));
    client.send("init", {
      room: roomId,
      html: this.room.html,
      fileName: this.room.fileName || "",
      comments: this.room.comments,
      edits: this.room.edits,
      clients: this.roomPresence(),
    }).catch(() => this.removeClient(clientId, heartbeat));
    this.broadcast("presence", this.roomPresence());

    heartbeat = setInterval(() => {
      client.ping().catch(() => this.removeClient(clientId, heartbeat));
    }, 20000);

    request.signal.addEventListener("abort", () => {
      this.removeClient(clientId, heartbeat);
    });

    return new Response(stream.readable, {
      headers: securityHeaders({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      }),
    });
  }

  async handleAction(action, body) {
    if (action === "html") {
      const html = String(body.html || "");
      if (byteLength(html) > maxRoomHtmlBytes) {
        throw new HttpError(413, "HTML file is too large. Keep uploads under 2 MB.");
      }

      this.room.html = await sanitizeDocumentHtml(html);
      this.room.fileName = cleanFileName(body.fileName);
      this.room.comments = [];
      this.room.edits = [];
      this.room.expiresAt = new Date(Date.now() + roomTtlMs).toISOString();
      await this.saveRoom();
      this.broadcast("html", { html: this.room.html, fileName: this.room.fileName, comments: [], edits: [] });
      return sendJson(200, { ok: true });
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
      await this.trackCommentEmail(comment.author).catch(() => {});
      this.room.comments.push(comment);
      await this.saveRoom();
      this.broadcast("comment", comment);
      return sendJson(200, { ok: true, comment });
    }

    if (action === "resolve-comment") {
      const commentId = String(body.id || "");
      this.room.comments.forEach((comment) => {
        if (comment.id === commentId || comment.parentId === commentId) {
          comment.resolved = true;
        }
      });
      await this.saveRoom();
      this.broadcast("resolve-comment", { id: commentId });
      return sendJson(200, { ok: true });
    }

    if (action === "edit") {
      const edit = {
        id: body.id || crypto.randomUUID(),
        type: String(body.type || "text"),
        path: Array.isArray(body.path) ? body.path.map(Number) : [],
        paths: Array.isArray(body.paths) ? body.paths.map((path) => Array.isArray(path) ? path.map(Number) : []) : undefined,
        targetPath: Array.isArray(body.targetPath) ? body.targetPath.map(Number) : undefined,
        items: Array.isArray(body.items) ? await Promise.all(body.items.slice(0, 200).map(async (item) => ({
          path: Array.isArray(item.path) ? item.path.map(Number) : undefined,
          html: typeof item.html === "string" ? await sanitizeHtmlFragment(item.html.slice(0, 1024 * 1024)) : "",
        }))) : undefined,
        html: typeof body.html === "string" ? await sanitizeHtmlFragment(body.html.slice(0, 1024 * 1024)) : undefined,
        htmls: Array.isArray(body.htmls) ? await Promise.all(body.htmls.slice(0, 200).map((html) => sanitizeHtmlFragment(String(html).slice(0, 1024 * 1024)))) : undefined,
        text: String(body.text || ""),
        author: String(body.author || "Anonymous").slice(0, 120),
        createdAt: body.createdAt || new Date().toISOString(),
      };
      this.room.edits.push(edit);
      await this.saveRoom();
      this.broadcast("edit", edit, body.clientId);
      return sendJson(200, { ok: true, edit });
    }

    if (action === "pointer") {
      const pointer = {
        clientId: String(body.clientId || ""),
        name: String(body.name || "Anonymous").slice(0, 120),
        color: String(body.color || "#2563eb"),
        x: Math.max(0, Math.min(1, Number(body.x) || 0)),
        y: Math.max(0, Math.min(1, Number(body.y) || 0)),
      };
      this.broadcast("pointer", pointer, pointer.clientId);
      return sendJson(200, { ok: true });
    }

    if (action === "presence") {
      const client = this.clients.get(String(body.clientId || ""));
      if (client) {
        client.name = String(body.name || client.name).slice(0, 120);
        client.color = String(body.color || client.color);
      }
      this.broadcast("presence", this.roomPresence());
      return sendJson(200, { ok: true });
    }

    return sendJson(404, { error: "Unknown room action" });
  }

  async trackCommentEmail(value) {
    const email = normalizeEmail(value);
    if (!email || !this.env.DB) return;
    if (!(await this.allowEmailTrackingWrite(email))) return;

    const now = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT INTO comment_users (email, created_at, last_seen)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(email, now, now).run();
  }

  async allowEmailTrackingWrite(email) {
    const now = Date.now();
    const windowStart = now - emailRateWindowMs;
    const rateLimits = await this.state.storage.get("emailRateLimits") || { room: [], emails: {} };
    rateLimits.room = pruneRateEvents(rateLimits.room, windowStart);
    rateLimits.emails[email] = pruneRateEvents(rateLimits.emails[email], windowStart);

    if (rateLimits.room.length >= maxEmailWritesPerRoomWindow || rateLimits.emails[email].length >= maxEmailWritesPerEmailWindow) {
      await this.state.storage.put("emailRateLimits", rateLimits);
      return false;
    }

    rateLimits.room.push(now);
    rateLimits.emails[email].push(now);
    await this.state.storage.put("emailRateLimits", rateLimits);
    return true;
  }

  roomPresence() {
    return Array.from(this.clients.values()).map(({ id, name, color }) => ({
      id,
      name,
      color,
    }));
  }

  broadcast(event, data, exceptId) {
    for (const client of this.clients.values()) {
      if (client.id === exceptId) continue;
      client.send(event, data).catch(() => this.removeClient(client.id));
    }
  }

  removeClient(clientId, heartbeat) {
    if (heartbeat) clearInterval(heartbeat);
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    client.close();
    this.broadcast("presence", this.roomPresence());
  }
}

function roomIdFromRequest(url) {
  if (url.pathname === "/events") {
    return url.searchParams.get("room") || "lobby";
  }
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[2] || "lobby";
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 10 * 1024 * 1024) {
    throw new HttpError(413, "Payload too large");
  }
  const body = await request.text();
  if (body.length > 10 * 1024 * 1024) {
    throw new HttpError(413, "Payload too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: securityHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return emailPattern.test(email) ? email : "";
}

function cleanFileName(fileName) {
  return String(fileName || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function emptyRoom() {
  return {
    html: "",
    fileName: "",
    comments: [],
    edits: [],
    expiresAt: null,
  };
}

function hasRoomContent(room) {
  return Boolean(room.html || room.comments?.length || room.edits?.length);
}

function isExpired(room) {
  return Boolean(room.expiresAt && Date.now() >= new Date(room.expiresAt).getTime());
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

async function sanitizeDocumentHtml(html) {
  return ensureDocumentCsp(await sanitizeHtmlFragment(html));
}

async function sanitizeHtmlFragment(html) {
  return new HTMLRewriter()
    .on("*", new SanitizerElementHandler())
    .transform(new Response(String(html || ""), {
      headers: { "content-type": "text/html; charset=utf-8" },
    }))
    .text();
}

class SanitizerElementHandler {
  element(element) {
    const tagName = String(element.tagName || "").toLowerCase();
    if (dangerousElements.has(tagName) || (tagName === "meta" && element.getAttribute("http-equiv"))) {
      element.remove();
      return;
    }

    for (const [name, value] of Array.from(element.attributes)) {
      const lowerName = name.toLowerCase();
      if (lowerName.startsWith("on") || lowerName === "srcdoc") {
        element.removeAttribute(name);
        continue;
      }
      if (lowerName === "style") {
        const safeStyle = sanitizeStyleValue(value);
        if (safeStyle) {
          element.setAttribute(name, safeStyle);
        } else {
          element.removeAttribute(name);
        }
        continue;
      }
      if (lowerName === "srcset") {
        if (!isSafeSrcset(value)) element.removeAttribute(name);
        continue;
      }
      if (urlAttributeNames.has(lowerName) && !isSafeUrl(value)) {
        element.removeAttribute(name);
      }
    }
  }
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

function securityHeaders(headers = {}) {
  return {
    ...headers,
    "content-security-policy": appCsp,
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "x-frame-options": "DENY",
  };
}

function hardenResponse(response) {
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders()).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };

  if (origin === "https://pairhtml.com" || origin === "https://www.pairhtml.com") {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }

  return headers;
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders()).forEach(([key, value]) => {
    headers.set(key, value);
  });
  Object.entries(corsHeaders(request)).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
