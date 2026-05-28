const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = process.env.PORT || 3000;
const host = process.env.HOST || "127.0.0.1";
const publicDir = path.join(__dirname, "public");
const rooms = new Map();

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
    });
  }
  return rooms.get(id);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
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
        room.html = String(body.html || "");
        room.comments = [];
        room.edits = [];
        broadcast(room, "html", { html: room.html, comments: [], edits: [] });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "comment") {
        const comment = {
          id: body.id || crypto.randomUUID(),
          parentId: body.parentId || null,
          x: Number(body.x) || 0,
          y: Number(body.y) || 0,
          author: String(body.author || "Anonymous").slice(0, 80),
          text: String(body.text || "").slice(0, 5000),
          createdAt: body.createdAt || new Date().toISOString(),
        };
        room.comments.push(comment);
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
            html: typeof item.html === "string" ? item.html.slice(0, 1024 * 1024) : "",
          })) : undefined,
          html: typeof body.html === "string" ? body.html.slice(0, 1024 * 1024) : undefined,
          htmls: Array.isArray(body.htmls) ? body.htmls.slice(0, 200).map((html) => String(html).slice(0, 1024 * 1024)) : undefined,
          text: String(body.text || ""),
          author: String(body.author || "Anonymous").slice(0, 80),
          createdAt: body.createdAt || new Date().toISOString(),
        };
        room.edits.push(edit);
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
