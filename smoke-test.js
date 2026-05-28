const fs = require("fs");
const { chromium } = require("/Users/kev/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

const room = `smoke-${Date.now()}`;
const url = `http://127.0.0.1:3000/?room=${room}`;
const longContent = Array.from({ length: 80 }, (_, index) => `<p>Long review row ${index + 1}</p>`).join("");
const sampleHtml = `<!doctype html>
<html>
  <head>
    <title>Sample</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 48px; }
      h1 { color: #1f2937; }
      p { max-width: 560px; }
    </style>
  </head>
  <body>
    <h1>Original title</h1>
    <p>This is a sample page for review.</p>
    ${longContent}
  </body>
</html>`;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.grantPermissions(["clipboard-write"], { origin: "http://127.0.0.1:3000" });
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  try {
    await pageA.goto(url);
    await pageB.goto(url);
    console.log("loaded clients");

    await pageA.locator("#copyLinkButton").getByText("Invite").waitFor();
    await pageA.locator("#copyLinkButton").click();
    await pageA.locator("#copyToast.visible").waitFor();
    await pageA.waitForFunction(() => !document.querySelector("#copyToast").classList.contains("visible"));
    console.log("verified invite toast");

    const initialPanelBox = await pageA.locator(".comments-panel").boundingBox();
    const handleBox = await pageA.locator("#panelResizeHandle").boundingBox();
    await pageA.mouse.move(handleBox.x + 4, handleBox.y + 40);
    await pageA.mouse.down();
    await pageA.mouse.move(handleBox.x - 80, handleBox.y + 40);
    await pageA.mouse.up();
    const resizedPanelBox = await pageA.locator(".comments-panel").boundingBox();
    if (resizedPanelBox.width <= initialPanelBox.width + 40) {
      throw new Error("Comments panel did not resize");
    }
    await pageA.locator("#togglePanelButton").click();
    await pageA.locator("#showPanelButton:not(.hidden)").waitFor();
    await pageA.locator("#showPanelButton").click();
    await pageA.waitForFunction(() => document.querySelector("#showPanelButton").classList.contains("hidden"));
    console.log("verified panel resize and toggle");

    await pageA.setInputFiles("#fileInput", {
      name: "sample.html",
      mimeType: "text/html",
      buffer: Buffer.from(sampleHtml),
    });
    console.log("uploaded html");

    const frameA = pageA.frameLocator("#preview");
    const frameB = pageB.frameLocator("#preview");
    await frameA.locator("h1").waitFor();
    await frameB.locator("h1").waitFor();
    await pageA.waitForFunction(() => document.querySelector("#emptyState").hidden);
    await frameA.locator("body").evaluate(() => {
      window.scrollTo(0, 600);
      if (window.scrollY < 500) {
        throw new Error("Frame did not scroll");
      }
    });
    console.log("rendered shared html");

    await frameA.locator("body").evaluate(() => window.scrollTo(0, 0));
    const h1BoxForDrag = await frameA.locator("h1").boundingBox();
    const pBoxForDrag = await frameA.locator("p").first().boundingBox();
    await pageA.mouse.move(h1BoxForDrag.x - 8, h1BoxForDrag.y - 8);
    await pageA.mouse.down();
    await pageA.mouse.move(pBoxForDrag.x + pBoxForDrag.width + 8, pBoxForDrag.y + pBoxForDrag.height + 8);
    await pageA.mouse.up();
    await pageA.waitForFunction(() => {
      return document.querySelector("#preview").contentDocument.querySelectorAll(".collab-selected").length >= 2;
    });
    console.log("multi-selected elements");

    await frameA.locator("p").first().click({ modifiers: ["Shift"] });
    await pageA.waitForFunction(() => {
      return document.querySelector("#preview").contentDocument.querySelectorAll(".collab-selected").length === 1;
    });
    await frameA.locator("p").first().click({ modifiers: ["Shift"] });
    await pageA.waitForFunction(() => {
      return document.querySelector("#preview").contentDocument.querySelectorAll(".collab-selected").length === 2;
    });
    console.log("shift-click toggled selection");

    await frameA.locator("p").first().click({ position: { x: 20, y: 10 } });
    await frameA.locator("p.collab-selected").first().waitFor();
    await pageA.waitForFunction(() => document.querySelector("#composer").classList.contains("hidden"));
    console.log("selected element");

    const paragraphBox = await frameA.locator("p").first().boundingBox();
    const expectedMarker = {
      x: paragraphBox.x + 20,
      y: paragraphBox.y + 10,
    };
    await frameA.locator("p").first().click({ button: "right", position: { x: 20, y: 10 } });
    await pageA.locator("#nameInput[placeholder='Name']").waitFor();
    await pageA.locator("#commentInput[placeholder='Comment']").waitFor();
    await pageA.locator("#nameInput").fill("Ada");
    await pageA.locator("#commentInput").fill("Please tighten this copy.");
    await pageA.locator(".composer-actions button[type='submit']").click();
    await pageB.waitForFunction(() => document.querySelector("#commentCount")?.textContent === "1");
    await frameA.locator(".collab-marker").waitFor();
    const markerBox = await frameA.locator(".collab-marker").boundingBox();
    const markerCenter = {
      x: markerBox.x + markerBox.width / 2,
      y: markerBox.y + markerBox.height / 2,
    };
    if (Math.abs(markerCenter.x - expectedMarker.x) > 14 || Math.abs(markerCenter.y - expectedMarker.y) > 14) {
      throw new Error(`Marker misplaced: ${JSON.stringify({ markerCenter, expectedMarker })}`);
    }
    await frameB.locator(".collab-marker").waitFor();
    await pageA.locator(".comment").hover();
    await frameA.locator(".collab-marker.is-highlighted").waitFor();
    console.log("synced comment");

    await frameB.locator(".collab-marker").click();
    await frameB.locator(".collab-reply-box").fill("Agree.");
    await frameB.locator(".collab-reply-send").click();
    await pageA.waitForTimeout(500);
    await frameA.locator(".collab-marker").click();
    await frameA.locator(".collab-popover").getByText("Agree.").waitFor();
    console.log("synced reply");

    await frameA.locator("h1").dblclick();
    await frameA.locator("h1.collab-editing").waitFor();
    await frameA.locator("h1").fill("Edited title");
    await frameA.locator("h1").press("Enter");
    console.log("local h1 after edit", await frameA.locator("h1").first().textContent());
    await frameB.locator("h1").filter({ hasText: "Edited title" }).waitFor();
    console.log("synced edit");

    await frameA.locator("h1").first().click();
    await frameA.locator("h1.collab-selected").first().waitFor();
    await pageA.keyboard.press("Control+C");
    await pageA.keyboard.press("Control+V");
    await frameB.locator("h1").filter({ hasText: "Edited title" }).nth(1).waitFor();
    console.log("synced duplicate");

    await pageA.keyboard.press("Delete");
    await pageB.waitForFunction(() => {
      return Array.from(document.querySelector("#preview").contentDocument.querySelectorAll("h1"))
        .filter((node) => node.textContent === "Edited title").length === 1;
    });
    console.log("synced delete");

    await frameA.locator("body").click({ position: { x: 4, y: 4 } });
    await pageA.keyboard.press("Control+V");
    await pageA.locator("#copyToast.visible").getByText("Select an element before pasting").waitFor();
    console.log("verified paste failure toast");

    await frameA.locator("p").first().hover();
    await frameB.locator(".collab-pointer").waitFor({ timeout: 3000 });
    await frameB.locator(".collab-pointer").evaluate((node) => {
      const shape = getComputedStyle(node, "::before").clipPath;
      if (!shape || shape === "none") {
        throw new Error("Pointer did not render as a cursor shape");
      }
    });
    console.log("verified pointer shape");

    const downloadPromise = pageA.waitForEvent("download");
    await pageA.locator("#saveButton").click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const savedHtml = fs.readFileSync(downloadPath, "utf8");
    if (!savedHtml.includes("Edited title") || savedHtml.includes("collab-marker") || savedHtml.includes("collab-selected")) {
      throw new Error("Saved HTML did not contain the clean latest document state");
    }
    console.log("verified save");

    console.log("smoke ok");
  } finally {
    await browser.close();
  }
})();
