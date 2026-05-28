# PAIRHTML

PAIRHTML is a minimal browser app for collaboratively reviewing and editing HTML files.

## Features

- Upload and render an HTML file in a shared room.
- Invite collaborators with a room link.
- See live presence and collaborator cursors.
- Select, multi-select, delete, copy, paste, and edit HTML elements.
- Leave comment threads on the page, reply, and resolve them.
- Save the edited HTML back to a downloadable file.

## Run Locally

```sh
npm start
```

Then open `http://127.0.0.1:3000`.

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
