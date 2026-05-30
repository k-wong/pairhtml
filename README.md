# PairHTML

PairHTML is a minimal browser app for collaboratively reviewing and editing HTML files. 

## Features

- Upload and render an HTML file in a shared room.
- Invite collaborators with a room link.
- See live presence and collaborator cursors.
- Select, multi-select, delete, copy, paste, and edit HTML elements.
- Leave comment threads on the page, reply, and resolve them.
- Save the edited HTML back to a downloadable file.
- Clone this to easily deploy behind a company firewall to use at work.

## Run Locally

```sh
npm start
```

Then open `http://127.0.0.1:3000`.

## Deploy on Cloudflare

This app includes a Cloudflare Worker entrypoint in `src/worker.mjs`.

- Static files are served from `public/` with Workers static assets.
- Live room state, comments, edits, presence, and SSE clients are coordinated by one Durable Object per room.
- Room HTML, comments, and edits automatically expire 24 hours after the room's first content write.
- Commenters are stored in D1 in `comment_users(email, created_at, last_seen)`.
- Prompt Codex/Claude to complete setup with your Cloudflare account, creating a D1 database, creating a `wrangler.toml`, and then run:

```sh
npm install
npm run d1:migrate:remote
npm run deploy
```

For local Cloudflare testing, run:

```sh
npm run d1:migrate:local
npm run dev:cloudflare
```

## Controls

- Click: select an element
- Shift + Click or Drag: multi-select elements
- Double Click: edit text
- Right Click or `C`: comment mode
- `V`: select mode
- Delete: delete selected elements
- Cmd/Ctrl + C: copy selected elements
- Cmd/Ctrl + V: paste after the selected element
- Cmd/Ctrl + Z: undo the last edit
- Esc: close popups
