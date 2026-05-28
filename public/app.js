const roomId = getRoomId();
const clientId = getClientId();
const clientColor = getClientColor();
const minPanelWidth = 260;
const maxPanelWidth = 640;
const maxUploadBytes = 2 * 1024 * 1024;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let userName = localStorage.getItem("html-collab-name") || "";
if (userName && !isValidEmail(userName)) {
  userName = "";
  localStorage.removeItem("html-collab-name");
}
let currentHtml = "";
let currentFileName = "";
let comments = [];
let edits = [];
let pendingComment = null;
let source = null;
let pointerTimer = 0;
let lastPointer = null;
let selectedElement = null;
let selectedElements = [];
let highlightedCommentId = null;
let copiedElementHtmls = [];
let undoAction = null;
let dragSelect = null;
let suppressNextClick = false;
let commentMode = false;

const workspace = document.querySelector(".workspace");
const preview = document.querySelector("#preview");
const emptyState = document.querySelector("#emptyState");
const fileInput = document.querySelector("#fileInput");
const uploadLabel = document.querySelector("#uploadLabel");
const copyLinkButton = document.querySelector("#copyLinkButton");
const saveButton = document.querySelector("#saveButton");
const copyToast = document.querySelector("#copyToast");
const roomLabel = document.querySelector("#roomLabel");
const presence = document.querySelector("#presence");
const commentsList = document.querySelector("#commentsList");
const commentCount = document.querySelector("#commentCount");
const composer = document.querySelector("#composer");
const nameInput = document.querySelector("#nameInput");
const commentInput = document.querySelector("#commentInput");
const cancelCommentButton = document.querySelector("#cancelCommentButton");
const submitCommentButton = document.querySelector("#submitCommentButton");
const commentTemplate = document.querySelector("#commentTemplate");
const panelResizeHandle = document.querySelector("#panelResizeHandle");
const togglePanelButton = document.querySelector("#togglePanelButton");
const showPanelButton = document.querySelector("#showPanelButton");
const helpButton = document.querySelector("#helpButton");
const helpPanel = document.querySelector("#helpPanel");
const helpCloseButton = document.querySelector("#helpCloseButton");

roomLabel.textContent = `Room ${roomId}`;
restorePanelWidth();
connectEvents();

fileInput.addEventListener("click", () => {
  fileInput.value = "";
});

fileInput.addEventListener("change", uploadHtmlFile);

async function uploadHtmlFile() {
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > maxUploadBytes) {
    showToast("HTML file must be under 2 MB");
    fileInput.value = "";
    return;
  }

  setUploadState(true);
  try {
    const html = await file.text();
    const sanitized = sanitizeHtml(html);
    const fileName = cleanFileName(file.name);
    await postJson(`/api/rooms/${roomId}/html`, { html: sanitized, fileName });
    currentHtml = sanitized;
    currentFileName = fileName;
    comments = [];
    edits = [];
    renderFrame();
    renderComments();
    showToast("HTML uploaded");
  } catch (error) {
    showToast(error.message || "Upload failed");
  } finally {
    setUploadState(false);
    fileInput.value = "";
  }
}

copyLinkButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(window.location.href);
  showToast("Room link copied");
});
saveButton.addEventListener("click", downloadCurrentHtml);

window.addEventListener("message", (event) => {
  if (event.source !== preview.contentWindow || !event.data) return;

  if (event.data.type === "frame-pointer") {
    lastPointer = event.data;
    schedulePointerSend();
  }

  if (event.data.type === "frame-edit") {
    saveTextEdit(event.data.path, event.data.text);
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitComment();
});

submitCommentButton.addEventListener("click", submitComment);
nameInput.addEventListener("input", () => {
  nameInput.setCustomValidity("");
});
commentInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitComment();
  }
});

async function submitComment() {
  if (!pendingComment) return;

  const author = getStoredEmail();
  if (!author) return;
  const text = commentInput.value.trim();
  if (!text) return;

  const comment = {
    id: crypto.randomUUID(),
    parentId: pendingComment.parentId,
    x: pendingComment.x,
    y: pendingComment.y,
    author,
    text,
    createdAt: new Date().toISOString(),
  };
  comments.push(comment);
  renderComments();
  renderCommentMarkers();
  closeComposer();
  await postJson(`/api/rooms/${roomId}/comment`, comment);
}

cancelCommentButton.addEventListener("click", closeComposer);
commentInput.addEventListener("input", () => autosizeTextarea(commentInput));
togglePanelButton.addEventListener("click", hideCommentsPanel);
showPanelButton.addEventListener("click", showCommentsPanel);
panelResizeHandle.addEventListener("pointerdown", startPanelResize);
helpButton.addEventListener("click", toggleHelpPanel);
helpCloseButton.addEventListener("click", hideHelpPanel);
window.addEventListener("resize", renderCommentMarkers);
window.addEventListener("keydown", handleKeyboardShortcut, true);
window.addEventListener("copy", handleCopyEvent, true);
window.addEventListener("paste", handlePasteEvent, true);

function getRoomId() {
  const url = new URL(window.location.href);
  let room = url.searchParams.get("room");
  if (!room) {
    room = crypto.randomUUID().slice(0, 8);
    url.searchParams.set("room", room);
    window.history.replaceState(null, "", url);
  }
  return room;
}

function getClientId() {
  let id = sessionStorage.getItem("html-collab-client");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("html-collab-client", id);
  }
  return id;
}

function getClientColor() {
  let color = sessionStorage.getItem("html-collab-color");
  if (!color) {
    const colors = ["#0071e3", "#34c759", "#ff9500", "#af52de", "#ff2d55", "#5e5ce6", "#64d2ff"];
    color = colors[Math.floor(Math.random() * colors.length)];
    sessionStorage.setItem("html-collab-color", color);
  }
  return color;
}

function connectEvents() {
  if (source) source.close();
  const params = new URLSearchParams({
    room: roomId,
    client: clientId,
    color: clientColor,
    name: userName || "Anonymous",
  });
  source = new EventSource(`/events?${params.toString()}`);

  source.addEventListener("init", (event) => {
    const data = JSON.parse(event.data);
    currentHtml = data.html || "";
    currentFileName = data.fileName || "";
    comments = data.comments || [];
    edits = data.edits || [];
    renderFrame();
    renderPresence(data.clients || []);
    renderComments();
  });

  source.addEventListener("html", (event) => {
    const data = JSON.parse(event.data);
    currentHtml = data.html || "";
    currentFileName = data.fileName || "";
    comments = data.comments || [];
    edits = data.edits || [];
    renderFrame();
    renderComments();
  });

  source.addEventListener("comment", (event) => {
    const comment = JSON.parse(event.data);
    if (!comments.some((item) => item.id === comment.id)) {
      comments.push(comment);
      renderComments();
      renderCommentMarkers();
    }
  });

  source.addEventListener("resolve-comment", (event) => {
    const data = JSON.parse(event.data);
    comments = comments.filter((comment) => comment.id !== data.id && comment.parentId !== data.id);
    renderComments();
    renderCommentMarkers();
    closeCommentPopover();
  });

  source.addEventListener("edit", (event) => {
    const edit = JSON.parse(event.data);
    if (!edits.some((item) => item.id === edit.id)) {
      edits.push(edit);
      applyEdit(edit);
    }
  });

  source.addEventListener("pointer", (event) => {
    renderPointer(JSON.parse(event.data));
  });

  source.addEventListener("presence", (event) => {
    renderPresence(JSON.parse(event.data));
  });
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script").forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.toLowerCase().startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    }
  });
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function renderFrame() {
  emptyState.hidden = Boolean(currentHtml);
  selectedElement = null;
  selectedElements = [];
  preview.addEventListener("load", onFrameLoaded, { once: true });
  preview.srcdoc = currentHtml || "<!doctype html><html><body></body></html>";
}

function onFrameLoaded() {
  injectFrameTools();
  ensureFrameScroll();
  edits.forEach(applyEdit);
  renderCommentMarkers();
}

function ensureFrameScroll() {
  const doc = preview.contentDocument;
  if (!doc || !doc.body) return;

  doc.documentElement.style.overflow = "auto";
  doc.documentElement.style.minHeight = "100%";
  doc.body.style.overflow = "auto";
  doc.body.style.minHeight = "100%";
  if (getComputedStyle(doc.body).position === "static") {
    doc.body.style.position = "relative";
  }
}

function injectFrameTools() {
  const doc = preview.contentDocument;
  if (!doc || doc.querySelector("#collab-style")) return;

  const style = doc.createElement("style");
  style.id = "collab-style";
  style.textContent = `
    .collab-marker {
      position: fixed;
      z-index: 2147483645;
      width: 24px;
      height: 24px;
      border-radius: 14px 14px 14px 4px;
      border: 2px solid rgba(255, 255, 255, .92);
      background: #0071e3;
      color: #fff;
      box-shadow: 0 8px 22px rgba(0, 0, 0, .22);
      display: grid;
      place-items: center;
      font: 700 10px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      transform: translate(-50%, -50%) rotate(-45deg);
      cursor: pointer;
      pointer-events: auto;
      transition: transform 140ms ease, box-shadow 140ms ease;
    }
    .collab-marker span {
      transform: rotate(45deg);
    }
    .collab-marker-layer {
      position: fixed;
      z-index: 2147483644;
      inset: 0;
      pointer-events: none;
    }
    .collab-marker.is-highlighted {
      animation: collab-marker-pulse 650ms ease-in-out 2;
      box-shadow: 0 0 0 8px rgba(0, 113, 227, .16), 0 8px 22px rgba(0, 0, 0, .22);
    }
    @keyframes collab-marker-pulse {
      0%, 100% { transform: translate(-50%, -50%) rotate(-45deg) scale(1); }
      50% { transform: translate(-50%, -50%) rotate(-45deg) scale(1.18); }
    }
    .collab-pointer {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      transform: translate(4px, 4px);
      display: flex;
      align-items: center;
      gap: 6px;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      color: #fff;
      text-shadow: 0 1px 1px rgba(0, 0, 0, .2);
    }
    .collab-pointer::before {
      content: "";
      width: 16px;
      height: 20px;
      background: var(--collab-color);
      clip-path: polygon(0 0, 0 18px, 5px 14px, 8px 20px, 12px 18px, 9px 12px, 16px 12px);
      filter: drop-shadow(0 1px 0 #fff) drop-shadow(0 2px 5px rgba(15, 23, 42, .3));
    }
    .collab-pointer span {
      border-radius: 999px;
      background: var(--collab-color);
      padding: 4px 7px;
      box-shadow: 0 2px 8px rgba(15, 23, 42, .25);
    }
    .collab-editing {
      outline: 2px solid #0071e3 !important;
      outline-offset: 2px !important;
    }
    .collab-selected {
      outline: 2px solid #0071e3 !important;
      outline-offset: 2px !important;
      cursor: default !important;
    }
    .collab-selected-large {
      box-shadow: inset 0 0 0 3px #0071e3 !important;
      outline-offset: -2px !important;
    }
    .collab-comment-mode, .collab-comment-mode * {
      cursor: none !important;
    }
    .collab-comment-cursor {
      position: fixed;
      z-index: 2147483647;
      width: 24px;
      height: 24px;
      border-radius: 14px 14px 14px 4px;
      background: #0071e3;
      box-shadow: 0 8px 22px rgba(0, 0, 0, .22);
      transform: translate(12%, -88%) rotate(-45deg);
      pointer-events: none;
      display: none;
    }
    .collab-comment-mode .collab-comment-cursor {
      display: block;
    }
    .collab-drag-box {
      position: fixed;
      z-index: 2147483647;
      border: 1px solid #0071e3;
      background: rgba(0, 113, 227, .12);
      pointer-events: none;
    }
    .collab-no-select, .collab-no-select * {
      user-select: none !important;
    }
    .collab-popover {
      position: fixed;
      z-index: 2147483647;
      width: min(390px, calc(100vw - 28px));
      border: 1px solid rgba(255, 255, 255, .34);
      border-radius: 24px;
      background: rgba(28, 28, 30, .92);
      color: #fff;
      box-shadow: 0 22px 64px rgba(0, 0, 0, .32);
      backdrop-filter: saturate(180%) blur(24px);
      -webkit-backdrop-filter: saturate(180%) blur(24px);
      overflow: visible;
      font: 15px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    .collab-popover-actions {
      position: absolute;
      right: -12px;
      top: -12px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .collab-popover-actions button,
    .collab-reply-send {
      border: 0;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      color: #fff;
      background: rgb(58, 58, 60);
      font: 22px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      cursor: pointer;
      box-shadow: 0 6px 18px rgba(0, 0, 0, .26);
    }
    .collab-popover-actions button:hover,
    .collab-reply-send:hover {
      background: rgba(72, 72, 74, 1);
    }
    .collab-resolve {
      border: 1px solid rgba(255, 255, 255, .18) !important;
      font-size: 18px !important;
    }
    .collab-thread {
      padding: 18px 14px 12px;
      display: grid;
      gap: 12px;
    }
    .collab-message,
    .collab-reply-row {
      display: grid;
      grid-template-columns: 40px 1fr;
      gap: 10px;
      align-items: start;
    }
    .collab-avatar {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #34c759;
      color: #fff;
      font-size: 17px;
      font-weight: 600;
    }
    .collab-message-meta {
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-weight: 600;
    }
    .collab-message-time {
      color: #a3a3a3;
      font-weight: 500;
    }
    .collab-message-text {
      margin-top: 2px;
      white-space: pre-wrap;
    }
    .collab-reply-box {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 42px;
      max-height: 132px;
      border: 0;
      border-radius: 21px;
      background: rgba(255, 255, 255, .12);
      color: #fff;
      padding: 11px 50px 11px 16px;
      font: inherit;
      line-height: 20px;
      outline: none;
      overflow: hidden;
      resize: none;
    }
    .collab-reply-box::placeholder {
      color: #a3a3a3;
    }
    .collab-reply-box:focus {
      outline: 3px solid rgba(0, 113, 227, .32);
    }
    .collab-reply-wrap {
      position: relative;
    }
    .collab-reply-send {
      position: absolute;
      right: 8px;
      bottom: 5px;
      background: rgba(255, 255, 255, .28);
      font-size: 20px;
      font-weight: 600;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .22);
    }
  `;
  doc.head.appendChild(style);
  const commentCursor = doc.createElement("div");
  commentCursor.className = "collab-comment-cursor";
  doc.body.appendChild(commentCursor);

  doc.addEventListener("mousemove", (event) => {
    positionCommentModeCursor(event.clientX, event.clientY);
    lastPointer = {
      x: event.clientX / Math.max(1, doc.defaultView.innerWidth),
      y: event.clientY / Math.max(1, doc.defaultView.innerHeight),
    };
    schedulePointerSend();
  });
  doc.defaultView.addEventListener("scroll", positionCommentMarkers, { passive: true });
  doc.defaultView.addEventListener("resize", renderCommentMarkers);

  doc.addEventListener("click", (event) => {
    if (event.target.closest(".collab-marker, .collab-popover")) return;
    if (suppressNextClick) {
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (commentMode) {
      openComposerFromFrameEvent(event);
      return;
    }
    if (event.shiftKey) {
      toggleSelectedElement(event.target, event);
    } else {
      selectElement(event.target, event);
    }
  }, true);

  doc.addEventListener("mousedown", (event) => {
    if (commentMode || event.button !== 0 || event.shiftKey || event.target.closest(".collab-marker, .collab-popover")) return;
    startDragSelect(event);
  }, true);

  doc.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".collab-marker, .collab-popover")) return;
    event.preventDefault();
    event.stopPropagation();
    selectElement(event.target, event);
    openComposerFromFrameEvent(event);
  }, true);

  doc.addEventListener("dblclick", (event) => {
    if (event.target.closest(".collab-marker, .collab-popover")) return;
    event.preventDefault();
    event.stopPropagation();
    startInlineEdit(event.target, event);
  }, true);
  doc.addEventListener("keydown", handleFrameKeydown, true);
  doc.addEventListener("copy", handleCopyEvent, true);
  doc.addEventListener("paste", handlePasteEvent, true);
}

function getReviewElement(target, point) {
  const element = getBaseReviewElement(target);
  if (!element) return null;
  if (!isObviousPageWrapper(element)) return element;
  return getChildReviewElementAtPoint(element, point) || element;
}

function getBaseReviewElement(target) {
  const doc = preview.contentDocument;
  if (!target || typeof target.closest !== "function") return null;
  const element = target.closest("body *:not(.collab-marker):not(.collab-pointer):not(.collab-popover):not(.collab-popover *)");
  if (!isSelectableReviewElement(element, doc)) return null;
  return element;
}

function isSelectableReviewElement(element, doc = preview.contentDocument) {
  return Boolean(
    element
      && element !== doc?.body
      && element !== doc?.documentElement
      && doc?.body?.contains(element)
      && !element.closest(".collab-marker, .collab-marker-layer, .collab-pointer, .collab-popover, script, style"),
  );
}

function getChildReviewElementAtPoint(container, point) {
  const doc = preview.contentDocument;
  if (!doc || !point) return null;

  const fromPoint = doc.elementsFromPoint(point.clientX, point.clientY)
    .map((element) => getBaseReviewElement(element))
    .filter((element) => element && element !== container && container.contains(element) && !isObviousPageWrapper(element));
  if (fromPoint.length) return fromPoint[0];

  return Array.from(container.querySelectorAll("*"))
    .filter((element) => isSelectableReviewElement(element, doc))
    .filter((element) => !isObviousPageWrapper(element) && containsPoint(element, point))
    .sort((a, b) => elementArea(a) - elementArea(b))[0] || null;
}

function selectElement(target, point) {
  const element = getReviewElement(target, point);
  if (!element) return null;

  setSelectedElements([element]);
  return selectedElement;
}

function toggleSelectedElement(target, point) {
  const element = getReviewElement(target, point);
  if (!element) return null;
  if (selectedElements.includes(element)) {
    setSelectedElements(selectedElements.filter((item) => item !== element));
    return null;
  }
  setSelectedElements([...selectedElements, element]);
  return element;
}

function setSelectedElements(elements) {
  selectedElements.forEach((element) => {
    if (element.isConnected) element.classList.remove("collab-selected", "collab-selected-large");
  });
  selectedElements = Array.from(new Set(elements)).filter(Boolean);
  selectedElements.forEach((element) => {
    element.classList.add("collab-selected");
    element.classList.toggle("collab-selected-large", isHugeSelectedElement(element));
  });
  selectedElement = selectedElements[selectedElements.length - 1] || null;
}

function startDragSelect(event) {
  const doc = preview.contentDocument;
  const startX = event.clientX;
  const startY = event.clientY;
  const box = doc.createElement("div");
  box.className = "collab-drag-box";
  doc.body.classList.add("collab-no-select");
  doc.body.appendChild(box);
  dragSelect = { startX, startY, box, didDrag: false };

  const move = (moveEvent) => {
    const left = Math.min(startX, moveEvent.clientX);
    const top = Math.min(startY, moveEvent.clientY);
    const width = Math.abs(moveEvent.clientX - startX);
    const height = Math.abs(moveEvent.clientY - startY);
    if (width > 4 || height > 4) dragSelect.didDrag = true;
    Object.assign(box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    if (dragSelect.didDrag) {
      setSelectedElements(getElementsInRect({ left, top, right: left + width, bottom: top + height }));
    }
  };
  const up = () => {
    doc.removeEventListener("mousemove", move, true);
    doc.removeEventListener("mouseup", up, true);
    doc.body.classList.remove("collab-no-select");
    box.remove();
    suppressNextClick = Boolean(dragSelect?.didDrag);
    dragSelect = null;
  };

  doc.addEventListener("mousemove", move, true);
  doc.addEventListener("mouseup", up, true);
}

function getElementsInRect(rect) {
  const doc = preview.contentDocument;
  return Array.from(doc.body.querySelectorAll("*"))
    .filter((element) => element !== doc.body && element !== doc.documentElement)
    .filter((element) => !element.closest(".collab-marker, .collab-marker-layer, .collab-pointer, .collab-popover, script, style"))
    .filter((element) => !isObviousPageWrapper(element))
    .filter((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0
        && bounds.height > 0
        && bounds.left < rect.right
        && bounds.right > rect.left
        && bounds.top < rect.bottom
        && bounds.bottom > rect.top;
    });
}

function isObviousPageWrapper(element) {
  const doc = preview.contentDocument;
  if (!doc?.body || element?.parentElement !== doc.body) return false;

  const bounds = element.getBoundingClientRect();
  const documentSize = getDocumentSize();
  const viewportWidth = doc.defaultView.innerWidth;
  const viewportHeight = doc.defaultView.innerHeight;
  const descendantCount = element.querySelectorAll("*").length;
  const coversViewport = bounds.width >= viewportWidth * 0.9 && bounds.height >= viewportHeight * 0.8;
  const coversDocument = bounds.width >= documentSize.width * 0.9 && bounds.height >= Math.min(documentSize.height, viewportHeight) * 0.8;

  return descendantCount >= 3 && (coversViewport || coversDocument);
}

function isHugeSelectedElement(element) {
  const doc = preview.contentDocument;
  if (!doc) return false;

  const bounds = element.getBoundingClientRect();
  return isObviousPageWrapper(element)
    || (bounds.width >= doc.defaultView.innerWidth * 0.85 && bounds.height >= doc.defaultView.innerHeight * 0.65);
}

function containsPoint(element, point) {
  const bounds = element.getBoundingClientRect();
  return bounds.width > 0
    && bounds.height > 0
    && point.clientX >= bounds.left
    && point.clientX <= bounds.right
    && point.clientY >= bounds.top
    && point.clientY <= bounds.bottom;
}

function elementArea(element) {
  const bounds = element.getBoundingClientRect();
  return bounds.width * bounds.height;
}

function handleFrameKeydown(event) {
  handleKeyboardShortcut(event);
}

function handleKeyboardShortcut(event) {
  const doc = preview.contentDocument;
  const activeElement = event.target instanceof Element ? event.target : doc.activeElement;
  if (event.key === "Escape") {
    if (!helpPanel.classList.contains("hidden")) {
      event.preventDefault();
      hideHelpPanel();
      return;
    }
    if (!composer.classList.contains("hidden")) {
      event.preventDefault();
      closeComposer();
      return;
    }
    if (preview.contentDocument?.querySelector(".collab-popover")) {
      event.preventDefault();
      closeCommentPopover();
      return;
    }
  }

  if (activeElement?.isContentEditable || ["INPUT", "TEXTAREA"].includes(activeElement?.tagName)) return;

  if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    setMode(commentMode ? "select" : "comment");
    return;
  }

  if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") {
    event.preventDefault();
    setMode("select");
    return;
  }

  const isCopy = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c";
  const isPaste = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
  const isUndo = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z";

  if (isUndo) {
    event.preventDefault();
    undoLastAction();
    return;
  }

  if (isCopy) {
    event.preventDefault();
    copySelectedElements();
    return;
  }

  if (isPaste) {
    event.preventDefault();
    pasteCopiedElements();
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelectedElements();
  }
}

function setMode(mode) {
  commentMode = mode === "comment";
  const doc = preview.contentDocument;
  doc?.body?.classList.toggle("collab-comment-mode", commentMode);
  showToast(commentMode ? "Entered comment mode" : "Entered select mode");
}

function positionCommentModeCursor(clientX, clientY) {
  const cursor = preview.contentDocument?.querySelector(".collab-comment-cursor");
  if (!cursor) return;
  cursor.style.left = `${clientX}px`;
  cursor.style.top = `${clientY}px`;
}

function openComposerFromFrameEvent(event) {
  const rect = preview.getBoundingClientRect();
  const size = getDocumentSize();
  openComposer(
    event.pageX / size.width,
    event.pageY / size.height,
    rect.left + event.clientX,
    rect.top + event.clientY,
    null,
  );
}

function handleCopyEvent(event) {
  if (!selectedElements.length) return;
  event.preventDefault();
  copySelectedElements();
}

function handlePasteEvent(event) {
  if (!selectedElement && !copiedElementHtmls.length) return;
  event.preventDefault();
  pasteCopiedElements();
}

function copySelectedElements() {
  if (!selectedElements.length) {
    showToast("Select an element before copying");
    return;
  }
  undoAction = { type: "copy", previousHtmls: copiedElementHtmls.slice() };
  copiedElementHtmls = selectedElements.map((element) => cleanElementHtml(element));
  showToast("Element copied");
}

function pasteCopiedElements() {
  if (!selectedElement || !selectedElement.isConnected) {
    showToast("Select an element before pasting");
    return;
  }
  if (!copiedElementHtmls.length) {
    showToast("Copy an element before pasting");
    return;
  }
  const edit = {
    type: "insertAfter",
    targetPath: getElementPath(selectedElement),
    htmls: copiedElementHtmls,
  };
  const inserted = applyInsertAfterEdit(edit);
  if (inserted.length) {
    setSelectedElements(inserted);
    undoAction = { type: "deleteMany", paths: inserted.map(getElementPath) };
  }
  postEdit(edit);
}

function deleteSelectedElements() {
  const items = selectedElements
    .filter((element) => element?.isConnected)
    .filter((element, _index, elements) => !elements.some((other) => other !== element && other.contains(element)))
    .map((element) => ({
      path: getElementPath(element),
      html: cleanElementHtml(element),
    }))
    .filter((item) => item.path.length && item.html)
    .sort((a, b) => comparePathsAscending(a.path, b.path));

  if (!items.length) {
    setSelectedElements([]);
    showToast("Select an element before deleting");
    return;
  }

  const edit = {
    type: "deleteMany",
    items,
  };
  undoAction = {
    type: "insertAt",
    items: items.map((item) => ({ path: item.path.slice(), html: item.html })),
  };
  applyEdit(edit);
  postEdit(edit);
  showToast(items.length === 1 ? "Element deleted" : "Elements deleted");
}

function comparePathsAscending(pathA = [], pathB = []) {
  return -comparePathsDescending(pathA, pathB);
}

function startInlineEdit(target, point) {
  const element = selectElement(target, point);
  if (!element) return;

  const original = element.textContent;
  element.contentEditable = "true";
  element.classList.add("collab-editing");
  element.focus();
  selectElementText(element);
  let saveTimer = 0;

  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTextEdit(getElementPath(element), element.textContent, original);
    }, 250);
  };
  const observer = new MutationObserver(queueSave);
  observer.observe(element, { childList: true, characterData: true, subtree: true });

  const finish = (save) => {
    clearTimeout(saveTimer);
    observer.disconnect();
    element.contentEditable = "false";
    element.classList.remove("collab-editing");
    element.removeEventListener("blur", blurHandler);
    element.removeEventListener("keydown", keyHandler);
    element.removeEventListener("input", inputHandler);
    if (!save) {
      element.textContent = original;
      return;
    }
    saveTextEdit(getElementPath(element), element.textContent, original);
  };
  const blurHandler = () => finish(true);
  const keyHandler = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };
  const inputHandler = () => queueSave();

  element.addEventListener("blur", blurHandler);
  element.addEventListener("keydown", keyHandler);
  element.addEventListener("input", inputHandler);
}

function selectElementText(element) {
  const selection = preview.contentWindow.getSelection();
  const range = preview.contentDocument.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function getElementPath(element) {
  const path = [];
  let current = element;
  while (current && current !== preview.contentDocument.body) {
    const parent = current.parentElement;
    path.unshift(Array.from(parent.children).indexOf(current));
    current = parent;
  }
  return path;
}

function getElementByPath(path) {
  let current = preview.contentDocument.body;
  for (const index of path) {
    current = current.children[index];
    if (!current) return null;
  }
  return current;
}

function applyEdit(edit) {
  if (edit.type === "deleteMany") {
    applyDeleteManyEdit(edit);
    return;
  }
  if (edit.type === "insertAfter") {
    applyInsertAfterEdit(edit);
    return;
  }
  if (edit.type === "insertAt") {
    applyInsertAtEdit(edit);
    return;
  }
  if (edit.type === "delete") {
    applyDeleteEdit(edit);
    return;
  }
  if (edit.type === "duplicate") {
    applyInsertAfterEdit({ targetPath: edit.targetPath, htmls: [edit.html] });
    return;
  }
  const element = getElementByPath(edit.path);
  if (element) {
    element.textContent = edit.text;
  }
}

function applyDeleteEdit(edit) {
  const element = getElementByPath(edit.path);
  if (!element) return;
  if (selectedElement === element) setSelectedElements([]);
  element.remove();
  renderCommentMarkers();
}

function applyDeleteManyEdit(edit) {
  const paths = (edit.items || edit.paths || [])
    .map((item) => Array.isArray(item) ? item : item.path)
    .filter(Boolean)
    .sort(comparePathsDescending);
  paths.forEach((path) => {
    const element = getElementByPath(path);
    if (element) element.remove();
  });
  setSelectedElements([]);
  renderCommentMarkers();
}

function applyInsertAfterEdit(edit) {
  const target = getElementByPath(edit.targetPath);
  const doc = preview.contentDocument;
  if (target === doc?.body || target === doc?.documentElement) return [];
  if (!target || !edit.htmls?.length) return [];
  const inserted = htmlsToElements(edit.htmls);
  let anchor = target;
  inserted.forEach((element) => {
    anchor.after(element);
    anchor = element;
  });
  renderCommentMarkers();
  return inserted;
}

function applyInsertAtEdit(edit) {
  const inserted = [];
  (edit.items || []).forEach((item) => {
    const parentPath = item.path.slice(0, -1);
    const index = item.path[item.path.length - 1];
    const parent = parentPath.length ? getElementByPath(parentPath) : preview.contentDocument.body;
    const element = htmlsToElements([item.html])[0];
    if (!parent || !element) return;
    parent.insertBefore(element, parent.children[index] || null);
    inserted.push(element);
  });
  if (inserted.length) setSelectedElements(inserted);
  renderCommentMarkers();
}

function htmlsToElements(htmls) {
  return htmls.map((html) => {
    const template = preview.contentDocument.createElement("template");
    template.innerHTML = html.trim();
    const element = template.content.firstElementChild;
    if (!element) return null;
    element.classList.remove("collab-selected", "collab-selected-large", "collab-editing");
    element.removeAttribute("contenteditable");
    return element;
  }).filter(Boolean);
}

function cleanElementHtml(element) {
  const clone = element.cloneNode(true);
  clone.classList.remove("collab-selected", "collab-selected-large", "collab-editing");
  clone.removeAttribute("contenteditable");
  if (!clone.getAttribute("class")) clone.removeAttribute("class");
  clone.querySelectorAll(".collab-selected, .collab-selected-large, .collab-editing").forEach((node) => {
    node.classList.remove("collab-selected", "collab-selected-large", "collab-editing");
    node.removeAttribute("contenteditable");
    if (!node.getAttribute("class")) node.removeAttribute("class");
  });
  return clone.outerHTML;
}

function comparePathsDescending(pathA = [], pathB = []) {
  const length = Math.max(pathA.length, pathB.length);
  for (let index = 0; index < length; index += 1) {
    const a = pathA[index] ?? -1;
    const b = pathB[index] ?? -1;
    if (a !== b) return b - a;
  }
  return 0;
}

function saveTextEdit(path, text, beforeText) {
  if (typeof beforeText === "string") {
    undoAction = { type: "text", path: path.slice(), text: beforeText };
  }
  postEdit({
    type: "text",
    path,
    text,
  });
}

function undoLastAction() {
  if (!undoAction) {
    showToast("Nothing to undo");
    return;
  }

  if (undoAction.type === "copy") {
    copiedElementHtmls = undoAction.previousHtmls;
    undoAction = null;
    showToast("Copy undone");
    return;
  }

  const edit = undoAction.type === "text"
    ? { type: "text", path: undoAction.path, text: undoAction.text }
    : undoAction;
  undoAction = null;
  applyEdit(edit);
  postEdit(edit);
  showToast("Undone");
}

function postEdit(edit) {
  const payload = {
    id: edit.id || crypto.randomUUID(),
    clientId,
    type: edit.type || "text",
    path: edit.path,
    paths: edit.paths,
    targetPath: edit.targetPath,
    items: edit.items,
    html: edit.html,
    htmls: edit.htmls,
    text: edit.text || "",
    author: getStoredName(),
    createdAt: new Date().toISOString(),
  };
  edits.push(payload);
  postJson(`/api/rooms/${roomId}/edit`, payload);
}

function renderCommentMarkers() {
  const doc = preview.contentDocument;
  if (!doc || !doc.body) return;

  let layer = doc.querySelector(".collab-marker-layer");
  if (!layer) {
    layer = doc.createElement("div");
    layer.className = "collab-marker-layer";
    doc.body.appendChild(layer);
  }
  layer.replaceChildren();

  comments.filter((comment) => !comment.parentId && !comment.resolved).forEach((comment, index) => {
    const marker = doc.createElement("button");
    marker.type = "button";
    marker.className = "collab-marker";
    marker.dataset.commentId = comment.id;
    marker.dataset.x = String(comment.x);
    marker.dataset.y = String(comment.y);
    marker.innerHTML = `<span>${index + 1}</span>`;
    marker.title = comment.text;
    marker.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      focusComment(comment.id);
      highlightCommentMarker(comment.id);
      openCommentPopover(comment.id);
    });
    layer.appendChild(marker);
  });
  positionCommentMarkers();
}

function positionCommentMarkers() {
  const doc = preview.contentDocument;
  if (!doc) return;

  const size = getDocumentSize();
  const scrollX = doc.defaultView.scrollX;
  const scrollY = doc.defaultView.scrollY;
  doc.querySelectorAll(".collab-marker").forEach((marker) => {
    const x = Number(marker.dataset.x) || 0;
    const y = Number(marker.dataset.y) || 0;
    marker.style.left = `${Math.round(x * size.width - scrollX)}px`;
    marker.style.top = `${Math.round(y * size.height - scrollY)}px`;
  });
}

function getDocumentSize() {
  const doc = preview.contentDocument;
  if (!doc) return { width: 1, height: 1 };
  const body = doc.body;
  const root = doc.documentElement;
  return {
    width: Math.max(1, root.scrollWidth, root.clientWidth, body?.scrollWidth || 0, body?.clientWidth || 0),
    height: Math.max(1, root.scrollHeight, root.clientHeight, body?.scrollHeight || 0, body?.clientHeight || 0),
  };
}

function highlightCommentMarker(id) {
  const doc = preview.contentDocument;
  if (!doc) return;

  highlightedCommentId = id;
  doc.querySelectorAll(".collab-marker.is-highlighted").forEach((marker) => {
    marker.classList.remove("is-highlighted");
  });
  const marker = doc.querySelector(`.collab-marker[data-comment-id="${CSS.escape(id)}"]`);
  if (!marker) return;
  marker.classList.remove("is-highlighted");
  void marker.offsetWidth;
  marker.classList.add("is-highlighted");
}

function openCommentPopover(id) {
  const doc = preview.contentDocument;
  if (!doc) return;
  closeCommentPopover();

  const root = comments.find((comment) => comment.id === id);
  if (!root) return;
  const thread = [root, ...comments.filter((comment) => comment.parentId === id && !comment.resolved)];
  const marker = doc.querySelector(`.collab-marker[data-comment-id="${CSS.escape(id)}"]`);
  const markerRect = marker?.getBoundingClientRect() || { left: 24, top: 24, right: 24 };
  const popover = doc.createElement("div");
  popover.className = "collab-popover";
  popover.dataset.commentPopover = id;
  popover.innerHTML = `
    <div class="collab-popover-actions">
      <button type="button" class="collab-resolve" title="Resolve" aria-label="Resolve">✓</button>
      <button type="button" class="collab-close" title="Close" aria-label="Close">×</button>
    </div>
    <div class="collab-thread">
      ${thread.map((comment) => `
        <div class="collab-message">
          <div class="collab-avatar">${escapeHtml(initials(comment.author))}</div>
          <div>
            <div class="collab-message-meta">
              <span>${escapeHtml(comment.author)}</span>
              <span class="collab-message-time">${formatTime(comment.createdAt)}</span>
            </div>
            <div class="collab-message-text">${escapeHtml(comment.text)}</div>
          </div>
        </div>
      `).join("")}
      <div class="collab-reply-row">
        <div class="collab-avatar">${escapeHtml(initials(userName || "A"))}</div>
        <div class="collab-reply-wrap">
          <textarea class="collab-reply-box" rows="1" placeholder="Reply"></textarea>
          <button type="button" class="collab-reply-send" aria-label="Send reply">↑</button>
        </div>
      </div>
    </div>
  `;
  doc.body.appendChild(popover);
  placeFloatingPanel(popover, markerRect);

  popover.querySelector(".collab-close").addEventListener("click", closeCommentPopover);
  popover.querySelector(".collab-resolve").addEventListener("click", () => resolveComment(id));
  const input = popover.querySelector(".collab-reply-box");
  autosizeTextarea(input);
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    const author = userName || "Anonymous";
    const reply = {
      id: crypto.randomUUID(),
      parentId: id,
      x: root.x,
      y: root.y,
      author,
      text,
      createdAt: new Date().toISOString(),
    };
    comments.push(reply);
    renderComments();
    openCommentPopover(id);
    postJson(`/api/rooms/${roomId}/comment`, reply);
  };
  popover.querySelector(".collab-reply-send").addEventListener("click", send);
  input.addEventListener("input", () => autosizeTextarea(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  input.focus();
}

function placeFloatingPanel(panel, anchorRect) {
  const frameWindow = preview.contentWindow;
  const margin = 14;
  const gap = 14;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const placements = [
    { left: anchorRect.right + gap, top: anchorRect.top - 12 },
    { left: anchorRect.left - width - gap, top: anchorRect.top - 12 },
    { left: anchorRect.left - width / 2, top: anchorRect.bottom + gap },
    { left: anchorRect.left - width / 2, top: anchorRect.top - height - gap },
  ];
  const viewportWidth = frameWindow.innerWidth;
  const viewportHeight = frameWindow.innerHeight;
  const best = placements.find((placement) => (
    placement.left >= margin
    && placement.top >= margin
    && placement.left + width <= viewportWidth - margin
    && placement.top + height <= viewportHeight - margin
  )) || placements
    .map((placement) => ({
      left: Math.min(viewportWidth - width - margin, Math.max(margin, placement.left)),
      top: Math.min(viewportHeight - height - margin, Math.max(margin, placement.top)),
    }))
    .sort((a, b) => {
      const aDistance = Math.abs(a.left - placements[0].left) + Math.abs(a.top - placements[0].top);
      const bDistance = Math.abs(b.left - placements[0].left) + Math.abs(b.top - placements[0].top);
      return aDistance - bDistance;
    })[0];
  panel.style.left = `${best.left}px`;
  panel.style.top = `${best.top}px`;
}

function autosizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(132, Math.max(42, textarea.scrollHeight))}px`;
}

function closeCommentPopover() {
  preview.contentDocument?.querySelectorAll(".collab-popover").forEach((node) => node.remove());
}

function resolveComment(id) {
  comments = comments.filter((comment) => comment.id !== id && comment.parentId !== id);
  renderComments();
  renderCommentMarkers();
  closeCommentPopover();
  postJson(`/api/rooms/${roomId}/resolve-comment`, { id });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPointer(pointer) {
  const doc = preview.contentDocument;
  if (!doc || !doc.body || pointer.clientId === clientId) return;

  let node = doc.querySelector(`[data-pointer="${CSS.escape(pointer.clientId)}"]`);
  if (!node) {
    node = doc.createElement("div");
    node.className = "collab-pointer";
    node.dataset.pointer = pointer.clientId;
    node.appendChild(doc.createElement("span"));
    doc.body.appendChild(node);
  }
  node.querySelector("span").textContent = pointer.name || "Anonymous";
  node.style.setProperty("--collab-color", pointer.color);
  node.style.left = `${pointer.x * 100}%`;
  node.style.top = `${pointer.y * 100}%`;
  clearTimeout(node.hideTimer);
  node.hideTimer = setTimeout(() => node.remove(), 3000);
}

function renderPresence(clients) {
  presence.innerHTML = "";
  clients.forEach((client) => {
    const bubble = document.createElement("div");
    bubble.className = "presence-bubble";
    bubble.style.background = client.color;
    bubble.title = client.id === clientId ? `${client.name} (you)` : client.name;
    bubble.textContent = initials(client.name);
    presence.appendChild(bubble);
  });
}

function renderComments() {
  const topLevel = comments.filter((comment) => !comment.parentId && !comment.resolved);
  commentCount.textContent = String(topLevel.length);
  commentsList.innerHTML = "";

  topLevel.forEach((comment, index) => {
    const node = commentTemplate.content.firstElementChild.cloneNode(true);
    node.id = `comment-${comment.id}`;
    node.dataset.commentId = comment.id;
    const replies = comments.filter((reply) => reply.parentId === comment.id && !reply.resolved);
    node.querySelector(".comment-meta").textContent = `#${index + 1} ${comment.author} · ${formatTime(comment.createdAt)}${replies.length ? ` · ${replies.length} ${replies.length === 1 ? "reply" : "replies"}` : ""}`;
    node.querySelector(".comment-text").innerHTML = `${escapeHtml(comment.text)}${replies.map((reply) => `<span class="comment-reply"><span class="comment-reply-meta">${escapeHtml(reply.author)} · ${formatTime(reply.createdAt)}</span><span>${escapeHtml(reply.text).replaceAll("\n", "<br>")}</span></span>`).join("")}`;
    node.addEventListener("mouseenter", () => highlightCommentMarker(comment.id));
    node.addEventListener("click", () => {
      highlightCommentMarker(comment.id);
      setActiveComment(comment.id);
      openCommentPopover(comment.id);
    });

    commentsList.appendChild(node);
  });
}

function focusComment(id) {
  const node = document.querySelector(`#comment-${CSS.escape(id)}`);
  if (node) {
    setActiveComment(id);
    node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    node.animate(
      [{ background: "#ccfbf1" }, { background: "#ffffff" }],
      { duration: 900, easing: "ease-out" },
    );
  }
}

function setActiveComment(id) {
  document.querySelectorAll(".comment.active").forEach((node) => node.classList.remove("active"));
  const node = document.querySelector(`#comment-${CSS.escape(id)}`);
  if (node) node.classList.add("active");
}

function openComposer(x, y, clientX, clientY, parentId) {
  pendingComment = { x, y, parentId };
  nameInput.value = userName;
  nameInput.hidden = Boolean(userName);
  nameInput.setCustomValidity("");
  commentInput.value = "";
  composer.classList.remove("hidden");
  autosizeTextarea(commentInput);
  placeComposer(clientX, clientY);
  (userName ? commentInput : nameInput).focus();
}

function placeComposer(clientX, clientY) {
  const margin = 12;
  const gap = 14;
  const width = composer.offsetWidth;
  const height = composer.offsetHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const placements = [
    { left: clientX + gap, top: clientY - height / 2 },
    { left: clientX - width - gap, top: clientY - height / 2 },
    { left: clientX - width / 2, top: clientY + gap },
    { left: clientX - width / 2, top: clientY - height - gap },
  ];
  const best = placements.find((placement) => (
    placement.left >= margin
    && placement.top >= margin
    && placement.left + width <= viewportWidth - margin
    && placement.top + height <= viewportHeight - margin
  )) || placements
    .map((placement) => ({
      left: Math.min(viewportWidth - width - margin, Math.max(margin, placement.left)),
      top: Math.min(viewportHeight - height - margin, Math.max(margin, placement.top)),
    }))
    .sort((a, b) => {
      const aDistance = Math.abs(a.left - clientX) + Math.abs(a.top - clientY);
      const bDistance = Math.abs(b.left - clientX) + Math.abs(b.top - clientY);
      return aDistance - bDistance;
    })[0];
  composer.style.left = `${Math.round(best.left)}px`;
  composer.style.top = `${Math.round(best.top)}px`;
}

function closeComposer() {
  pendingComment = null;
  composer.classList.add("hidden");
}

function toggleHelpPanel() {
  helpPanel.classList.toggle("hidden");
}

function hideHelpPanel() {
  helpPanel.classList.add("hidden");
}

function showToast(message) {
  copyToast.textContent = message;
  copyToast.classList.add("visible");
  clearTimeout(copyToast.hideTimer);
  copyToast.hideTimer = setTimeout(() => {
    copyToast.classList.remove("visible");
  }, Math.max(1500, Math.min(4200, String(message).length * 80)));
}

function setUploadState(isUploading) {
  fileInput.disabled = isUploading;
  fileInput.closest(".upload-button")?.classList.toggle("is-loading", isUploading);
  fileInput.closest(".upload-button")?.setAttribute("aria-busy", String(isUploading));
  uploadLabel.textContent = isUploading ? "Uploading..." : "Upload HTML";
}

function downloadCurrentHtml() {
  if (!currentHtml) {
    showToast("Upload HTML before saving");
    return;
  }

  const doc = preview.contentDocument;
  if (!doc) {
    showToast("Nothing to save yet");
    return;
  }
  const clone = doc.documentElement.cloneNode(true);
  clone.querySelector("#collab-style")?.remove();
  clone.querySelectorAll(".collab-marker-layer, .collab-pointer, .collab-popover, .collab-drag-box, .collab-comment-cursor").forEach((node) => node.remove());
  clone.querySelectorAll(".collab-selected, .collab-selected-large, .collab-editing").forEach((node) => {
    node.classList.remove("collab-selected", "collab-selected-large", "collab-editing");
    node.removeAttribute("contenteditable");
    if (!node.getAttribute("class")) {
      node.removeAttribute("class");
    }
  });

  const html = `<!doctype html>\n${clone.outerHTML}`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = editedFileName(currentFileName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("HTML saved");
}

function editedFileName(fileName) {
  const fallback = `html-collab-${roomId}.html`;
  const safeName = cleanFileName(fileName);
  if (!safeName) return fallback;

  const match = safeName.match(/^(.*?)(\.[^.]+)?$/);
  const baseName = (match?.[1] || safeName).replace(/-edited$/i, "") || "html";
  const extension = match?.[2] || ".html";
  return `${baseName}-edited${extension}`;
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

function restorePanelWidth() {
  const storedWidth = Number(localStorage.getItem("html-collab-panel-width"));
  if (storedWidth) {
    setPanelWidth(storedWidth);
  }
}

function setPanelWidth(width) {
  const nextWidth = Math.max(minPanelWidth, Math.min(maxPanelWidth, width));
  document.documentElement.style.setProperty("--comments-width", `${nextWidth}px`);
  localStorage.setItem("html-collab-panel-width", String(nextWidth));
  requestAnimationFrame(renderCommentMarkers);
}

function startPanelResize(event) {
  if (workspace.classList.contains("comments-collapsed")) return;
  panelResizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-comments");

  const handleMove = (moveEvent) => {
    setPanelWidth(window.innerWidth - moveEvent.clientX);
  };
  const handleUp = () => {
    document.body.classList.remove("resizing-comments");
    panelResizeHandle.releasePointerCapture(event.pointerId);
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  };

  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp, { once: true });
}

function hideCommentsPanel() {
  workspace.classList.add("comments-collapsed");
  showPanelButton.classList.remove("hidden");
  togglePanelButton.setAttribute("aria-label", "Hide comments panel");
  requestAnimationFrame(renderCommentMarkers);
}

function showCommentsPanel() {
  workspace.classList.remove("comments-collapsed");
  showPanelButton.classList.add("hidden");
  requestAnimationFrame(renderCommentMarkers);
}

function getStoredEmail() {
  if (!userName) {
    const email = nameInput.value.trim().toLowerCase();
    if (!isValidEmail(email)) {
      nameInput.setCustomValidity("Enter a valid email address.");
      nameInput.reportValidity();
      return "";
    }
    nameInput.setCustomValidity("");
    userName = email;
    localStorage.setItem("html-collab-name", userName);
    postJson(`/api/rooms/${roomId}/presence`, { clientId, name: userName, color: clientColor });
  }
  return userName;
}

function getStoredName() {
  return userName || "Anonymous";
}

function isValidEmail(value) {
  return emailPattern.test(String(value || "").trim());
}

function schedulePointerSend() {
  if (pointerTimer) return;
  pointerTimer = window.setTimeout(async () => {
    pointerTimer = 0;
    if (!lastPointer) return;
    await postJson(`/api/rooms/${roomId}/pointer`, {
      clientId,
      name: userName || "Anonymous",
      color: clientColor,
      x: lastPointer.x,
      y: lastPointer.y,
    });
  }, 80);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function initials(name) {
  return (name || "A")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("") || "A";
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
