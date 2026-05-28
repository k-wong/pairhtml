const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roomTtlMs = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/events" || url.pathname.startsWith("/api/rooms/")) {
      const roomId = roomIdFromRequest(url);
      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
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
        return sendJson(400, { error: error.message || "Bad request" });
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
    this.broadcast("html", { html: "", comments: [], edits: [] });
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
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  async handleAction(action, body) {
    if (action === "html") {
      this.room.html = String(body.html || "");
      this.room.comments = [];
      this.room.edits = [];
      this.room.expiresAt = new Date(Date.now() + roomTtlMs).toISOString();
      await this.saveRoom();
      this.broadcast("html", { html: this.room.html, comments: [], edits: [] });
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
      await this.trackCommentEmail(comment.author);
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
        items: Array.isArray(body.items) ? body.items.slice(0, 200).map((item) => ({
          path: Array.isArray(item.path) ? item.path.map(Number) : undefined,
          html: typeof item.html === "string" ? item.html.slice(0, 1024 * 1024) : "",
        })) : undefined,
        html: typeof body.html === "string" ? body.html.slice(0, 1024 * 1024) : undefined,
        htmls: Array.isArray(body.htmls) ? body.htmls.slice(0, 200).map((html) => String(html).slice(0, 1024 * 1024)) : undefined,
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
    const now = new Date().toISOString();

    await this.env.DB.prepare(
      `INSERT INTO comment_users (email, created_at, last_seen)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(email, now, now).run();
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
    throw new Error("Payload too large");
  }
  const body = await request.text();
  if (body.length > 10 * 1024 * 1024) {
    throw new Error("Payload too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return emailPattern.test(email) ? email : "";
}

function emptyRoom() {
  return {
    html: "",
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
