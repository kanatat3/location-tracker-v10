// End-to-end: uses the app like a field worker and like the admin, on a phone and on a desktop,
// and checks every main screen against WCAG 2.1 AA with axe. Runs against the fake backend only.
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDb, installFakeBackend, OUTSIDE } from "./fake-backend.mjs";

const isMobile = () => test.info().project.name === "mobile";

async function checkA11y(page, state) {
  await page.waitForTimeout(400);                    // let the view fade-in finish so colours are final
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude(".leaflet-container")          // the third-party map canvas is out of our hands
    .analyze();
  const summary = results.violations.map(v => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
  expect(summary, `accessibility of ${state}`).toEqual([]);
}

const openProject = async (page, name) => {
  await page.locator(".figma-project-card", { hasText: name }).first().click();
  await expect(page.locator("#tracker-view")).toBeVisible();
  await expect(page.locator("#tracker-title")).toHaveText(name);
  await page.waitForTimeout(1500);
};
const noErrors = async page => expect(await page.evaluate(() => window.__errors)).toEqual([]);
const toast = page => page.locator("#messageBox");

test.describe("field worker", () => {
  let db;
  test.beforeEach(async ({ page }) => { db = createDb(); await installFakeBackend(page, db); await page.goto("/"); await expect(page.locator(".figma-project-card").first()).toBeVisible(); });

  test("project list: open projects, closed ones stay shut", async ({ page }) => {
    await expect(page.locator(".figma-project-card")).toHaveCount(3);
    expect(await page.locator(".figma-project-card").first().evaluate(el => el.tagName)).toBe("BUTTON");
    await page.locator(".figma-project-card").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#tracker-view")).toBeVisible();
    await page.click("#home-button");
    await expect(page.locator(".figma-project-card", { hasText: "Gamma" }).locator(".lt-closed-tag")).toHaveText(/closed/i);
    await checkA11y(page, "project list");
    await page.locator(".figma-project-card", { hasText: "Gamma" }).click();
    await expect(page.locator("#project-selection-view")).toBeVisible();
    await expect(toast(page)).toContainText(/project closed/i);
    await page.fill("#project-search-input", "bet");
    await expect(page.locator(".figma-project-card")).toHaveCount(1);
    await noErrors(page);
  });

  test("pin, upload in one press, report a record", async ({ page }) => {
    await openProject(page, "Alpha");
    await expect(page.locator("#savedLocationsTableBody .lt-empty-row")).toContainText(/no records in this project yet/i);
    await expect(page.locator("#pin-hint")).toBeVisible();
    // nothing to send yet: the buttons are off and say why, instead of failing after the press
    await expect(page.locator("#uploadButton")).toBeDisabled();
    await expect(page.locator("#saveButton")).toBeDisabled();
    await expect(page.locator("#action-reason")).toContainText(/set the location on the map/i);
    await page.click("#home-button");
    await openProject(page, "Beta");
    await expect(page.locator("#total-pin-count")).toHaveText("TOTAL 3");
    await expect(page.locator("#sync-status")).toBeHidden();
    await expect(page.locator("#map .lt-building-marker")).toHaveCount(1);
    await expect(page.locator("#map .leaflet-overlay-pane path")).toHaveCount(0);   // radius circles are for the admin only
    await checkA11y(page, "pin screen");

    // the first screen ends at the Upload button on a phone; Recent Sessions sits below the fold
    const box = await page.evaluate(() => ({ ih: innerHeight, up: document.getElementById("uploadButton").getBoundingClientRect().bottom, recent: document.querySelector(".lt-section-head").getBoundingClientRect().top, map: document.getElementById("map-container").getBoundingClientRect().height }));
    if (isMobile()) { expect(box.up).toBeLessThanOrEqual(box.ih); expect(box.recent).toBeGreaterThanOrEqual(box.ih - 1); expect(box.map).toBe(box.ih); }
    else expect(box.up).toBeLessThanOrEqual(box.ih);

    await page.locator("#map").click({ position: { x: 120, y: 120 } });
    await expect(page.locator("#lat")).not.toHaveText("--.------");
    await expect(page.locator("#pin-hint")).toBeHidden();
    await expect(page.locator("#uploadButton")).toBeDisabled();
    await expect(page.locator("#action-reason")).toContainText(/enter employee id, enter survey id/i);
    await expect(page.locator("#action-reason")).not.toContainText(/location/i);
    await page.fill("#employeeIdInput", "0861");
    await page.fill("#surveyIdInput", "S-101");
    await expect(page.locator("#uploadButton")).toBeEnabled();
    await expect(page.locator("#uploadButton")).toContainText("UPLOAD 1 PIN");
    await expect(page.locator("#action-reason")).toBeHidden();
    await page.click("#uploadButton");
    await expect(page.locator("#loading-spinner-text")).toHaveText(/completed/i, { timeout: 15000 });
    await expect(page.locator("#loadingSpinner")).toBeHidden({ timeout: 15000 });
    await expect.poll(() => db.posts.filter(p => p.action === "add").length).toBe(1);
    const add = db.posts.find(p => p.action === "add");
    expect(add.project).toBe("Beta"); expect(add.data.name).toBe("0861"); expect(add.data.surveyId).toBe("S-101");
    await expect(page.locator("#total-pin-count")).toHaveText("TOTAL 4");
    await expect(page.locator("#employeeIdInput")).toHaveValue("0861");  // locked, ready for the next pin

    // a pin far outside the widest circle is warned about without any figures
    await page.evaluate(({ lat, lng }) => updateDisplay(lat, lng), OUTSIDE);
    await page.fill("#surveyIdInput", "S-102");
    await page.click("#saveButton");
    await expect(toast(page)).toContainText(/outside the allowed area/i);
    await expect(toast(page)).not.toContainText(/km/i);
    await expect(page.locator("#savedLocationsTableBody tr", { hasText: "S-102" }).locator(".fa-triangle-exclamation")).toHaveCount(1);
    await page.click("#uploadButton");
    await expect(toast(page)).toContainText(/outside the allowed area/i, { timeout: 15000 });
    await expect.poll(() => db.rows.Beta.filter(r => r.OutOfRadius).length).toBe(1);

    // report the record to the admin
    await page.locator("#savedLocationsTableBody tr", { hasText: "S-102" }).locator(".lt-flag-btn").click();
    await expect(page.locator("#reportModal")).toBeVisible();
    await expect(page.locator("#report-record")).toContainText("S-102");
    await checkA11y(page, "report window");
    await page.keyboard.press("Escape");
    await expect(page.locator("#reportModal")).toBeHidden();
    expect(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("lt-flag-btn"))).toBe(true);
    await page.locator("#savedLocationsTableBody tr", { hasText: "S-102" }).locator(".lt-flag-btn").click();
    await expect(page.locator("#reportModal")).toBeVisible();
    expect(await page.evaluate(() => document.getElementById("reportModal").contains(document.activeElement))).toBe(true);
    await page.click("#report-send");
    await expect(toast(page)).toContainText(/choose what/i);
    await expect(toast(page)).toBeVisible();   // the toast shows above the open dialog
    await page.check('input[name="report-request"][value="wrong_survey"]');
    await page.fill("#report-note", "should be 108");
    await page.click("#report-send");
    await expect(page.locator("#reportModal")).toBeHidden();
    await expect(toast(page)).toContainText(/sent to the admin/i);
    expect(db.reports).toHaveLength(1);
    expect(db.reports[0]).toMatchObject({ Project: "Beta", SurveyID: "S-102", Request: "wrong_survey", Note: "should be 108", ReportedBy: "0861" });
    await noErrors(page);
  });

  test("company logo sits in front of the project name", async ({ page }) => {
    const name = "DOW Thailand Group Community Acceptance Survey 2026";
    db.projects.push(name); db.rows[name] = [];
    await page.route("**/www.google.com/s2/favicons**", route => route.abort());   // offline icon: the initials badge stays
    await page.reload();
    const card = page.locator(".figma-project-card", { hasText: "DOW Thailand" });
    await expect(card.locator(".lt-brand-badge")).toHaveText("DOW");
    await card.click();
    await expect(page.locator("#tracker-title")).toHaveText(name);
    await expect(page.locator("#tracker-brand .lt-brand-badge")).toHaveText("DOW");
    // logo and name share one line; the name is cut with … on a phone, never pushed off the panel
    const box = await page.evaluate(() => {
      const b = document.querySelector("#tracker-brand .lt-brand-badge").getBoundingClientRect(), t = document.getElementById("tracker-title").getBoundingClientRect(), head = document.querySelector(".lt-sheet-head").getBoundingClientRect();
      // the name itself stays in the centre of the header, as it was before the logo
      return { sameLine: Math.abs((b.top + b.bottom) / 2 - (t.top + t.bottom) / 2) < 6, before: b.right <= t.left + 1, inside: t.right <= head.right && b.left >= head.left,
        centred: Math.abs((t.left + t.right) / 2 - (head.left + head.right) / 2) <= 2 };
    });
    expect(box).toEqual({ sameLine: true, before: true, inside: true, centred: true });
    await checkA11y(page, "pin screen with company logo");
    // a project without a company keyword shows no logo
    await page.click("#home-button");
    await openProject(page, "Alpha");
    await expect(page.locator("#tracker-brand .lt-brand-badge")).toHaveCount(0);
    const plain = await page.evaluate(() => { const t = document.getElementById("tracker-title").getBoundingClientRect(), h = document.querySelector(".lt-sheet-head").getBoundingClientRect(); return Math.abs((t.left + t.right) / 2 - (h.left + h.right) / 2); });
    expect(plain).toBeLessThanOrEqual(2);
    await noErrors(page);
  });

  test("map tiles: real tiles up to zoom 22, failed tiles are fetched again", async ({ page }) => {
    // a 1x1 png stands in for every Google tile; the first request for each tile fails once
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const seen = new Map(), zooms = new Set();
    await page.route(/google\.com\/vt\/lyrs=m/, route => {
      // Google tile URLs carry x/y/z after "lyrs=m&" with no "?", so read them by pattern
      const url = route.request().url();
      const part = k => (url.match(new RegExp("[&?]" + k + "=([0-9]+)")) || [])[1];
      const key = ["x", "y", "z"].map(part).join("/");
      zooms.add(Number(part("z")));
      const n = (seen.get(key) || 0) + 1; seen.set(key, n);
      if (n === 1) return route.abort("connectionreset");
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    });
    await page.reload();
    await openProject(page, "Beta");
    await page.evaluate(() => map.setView([13.790167, 100.562522], 22, { animate: false }));
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => map.getZoom())).toBe(22);
    expect(zooms.has(22)).toBe(true);                       // drawn from zoom-22 tiles, not stretched zoom-20 ones
    const tiles = await page.evaluate(() => [...document.querySelectorAll("#map .leaflet-tile")].filter(t => t.src.includes("z=22")).map(t => ({ ok: t.classList.contains("leaflet-tile-loaded") && t.naturalWidth > 0, src: t.src })));
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every(t => t.ok)).toBe(true);              // every failed tile came back on the retry
    expect([...seen.values()].some(n => n >= 2)).toBe(true);
    await noErrors(page);
  });

  test("map search: as you type, typos, keyboard, coordinates, nothing found", async ({ page }) => {
    await openProject(page, "Beta");
    await page.click("#toggleSearchBtn");
    const input = page.locator("#locationSearchInput");
    const options = page.locator("#search-listbox [role=option]");

    // a typo still finds the place, the list works with the keyboard and passes axe
    await input.fill("เซนทรัลเวิล");
    await expect(options.first()).toContainText("เซ็นทรัลเวิลด์");
    await expect(options.first()).toContainText("ปทุมวัน");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await checkA11y(page, "search suggestions");
    await input.press("ArrowDown");
    await expect(page.locator("#search-opt-0")).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveAttribute("aria-activedescendant", "search-opt-0");
    await input.press("Enter");
    await expect(page.locator("#lat")).toHaveText("13.746800");
    await expect(page.locator("#search-suggestions")).toBeHidden();
    await expect(input).toHaveValue("");

    // an exact Thai name that only Nominatim knows
    await input.fill("สยามพารากอน");
    await expect(options.first()).toContainText("สยามพารากอน");
    // misspelt: the sound-alike spelling is found and Find takes the first result
    await input.fill("สยามพารากอล");
    await expect(page.locator("#search-status")).toContainText(/no exact match/i);
    await expect(options.first()).toContainText("สยามพารากอน");
    await page.click("#searchLocationButton");
    await expect(page.locator("#lat")).toHaveText("13.746100");

    // a pasted coordinate or Google Maps link goes straight there
    await input.fill("13.7563, 100.5018");
    await expect(options.first()).toContainText("13.756300, 100.501800");
    await input.press("Enter");
    await expect(page.locator("#lat")).toHaveText("13.756300");
    await expect(page.locator("#lng")).toHaveText("100.501800");
    await input.fill("https://www.google.com/maps/place/x/@13.7465,100.5348,17z");
    await page.click("#searchLocationButton");
    await expect(page.locator("#lat")).toHaveText("13.746500");

    // nothing found says so, Esc closes the list
    await input.fill("ไม่มีที่นี่");
    await expect(page.locator("#search-status")).toContainText(/no places found/i);
    await input.press("Escape");
    await expect(page.locator("#search-suggestions")).toBeHidden();

    // names from the map service are shown as text, never run as HTML
    await input.fill("evil");
    await expect(options.first()).toContainText("Evil Mall");
    expect(await page.locator("#search-listbox img").count()).toBe(0);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();

    // no connection to the map services
    db.geoOffline = true;
    await input.fill("ร้านกาแฟ");
    await expect(page.locator("#search-status")).toContainText(/search unavailable/i);

    // Photon hangs: after 8 s Nominatim answers instead of "Searching..." forever
    db.geoOffline = false; db.photonHang = true;
    await input.fill("ตลาดน้ำ");
    await expect(options.first()).toContainText("Somewhere", { timeout: 15000 });
    await noErrors(page);
  });

  test("big project: every pin on the map, a short list, Mine filter", async ({ page }) => {
    // 150 saved records from 5 people around the main coordinate
    db.rows.Beta = Array.from({ length: 150 }, (_, i) => ({ EmployeeID: ["861", "781", "864", "902", "915"][i % 5], SurveyID: String(1000 + i),
      Latitude: 13.7465 + (i % 15) * 0.0015, Longitude: 100.5348 + Math.floor(i / 15) * 0.0015,
      Timestamp: new Date(Date.UTC(2026, 8, 1) + i * 3600e3).toISOString(), OutOfRadius: false, DistanceKm: 0, RadiusKm: 10, RadiusKms: [3, 5, 10], ID: i + 2 }));
    await page.reload();
    await openProject(page, "Beta");
    await expect(page.locator("#total-pin-count")).toHaveText("TOTAL 150");
    // every saved pin is drawn on its own (the user does not want grouped pins)
    await expect(page.locator("#map .marker-cluster")).toHaveCount(0);
    expect(await page.locator("#map .leaflet-marker-pane img[src*='blue']").count()).toBe(150);
    // the list shows the newest 20
    await expect(page.locator("#savedLocationsTableBody tr")).toHaveCount(20);
    await expect(page.locator("#savedLocationsTableBody tr").first()).toContainText("1149");
    await expect(page.locator("#records-note")).toHaveText("Newest 20 of 150");
    await page.click("#records-more-btn");
    await expect(page.locator("#savedLocationsTableBody tr")).toHaveCount(150);
    await expect(page.locator("#records-more-btn")).toHaveText("Show fewer");
    await page.click("#records-more-btn");
    await expect(page.locator("#savedLocationsTableBody tr")).toHaveCount(20);
    // Mine narrows the list to the typed Employee ID
    await expect(page.locator("#records-filter")).toBeHidden();
    await page.fill("#employeeIdInput", "902");
    await expect(page.locator("#records-filter")).toBeVisible();
    await page.click("#records-filter-mine");
    await expect(page.locator("#records-filter-mine")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#savedLocationsTableBody tr")).toHaveCount(20);
    await expect(page.locator("#records-note")).toHaveText("Newest 20 of 30");
    expect(await page.locator("#savedLocationsTableBody tr td:nth-child(2)").allInnerTexts()).toEqual(Array(20).fill("902"));
    await page.click("#records-filter-all");
    await expect(page.locator("#records-note")).toHaveText("Newest 20 of 150");
    // a waiting record is always listed
    await page.locator("#map").click({ position: { x: 60, y: 60 } });
    await page.fill("#surveyIdInput", "S-W1");
    await page.click("#saveButton");
    await expect(page.locator("#savedLocationsTableBody tr", { hasText: "S-W1" })).toContainText("⏳");
    expect(await page.locator("#map .leaflet-marker-pane img[src*='grey']").count()).toBeGreaterThanOrEqual(1);
    await checkA11y(page, "big project pin screen");
    await noErrors(page);
  });

  test("buttons count the pins, say why they are off, Employee ID is remembered", async ({ page }) => {
    await openProject(page, "Beta");
    const up = page.locator("#uploadButton"), save = page.locator("#saveButton"), reason = page.locator("#action-reason"), eid = page.locator("#employeeIdInput");
    await page.locator("#map").click({ position: { x: 100, y: 100 } });
    await eid.fill("0861");
    await eid.press("Enter");                                   // locks it
    await expect(eid).toBeDisabled();

    // two pins saved on the phone: Upload counts them, Save waits for a new entry
    await page.fill("#surveyIdInput", "S-1"); await save.click();
    await page.evaluate(() => updateDisplay(13.75, 100.53));
    await page.fill("#surveyIdInput", "S-2"); await save.click();
    await expect(up).toContainText("UPLOAD 2 PINS");
    await expect(up).toBeEnabled();
    await expect(save).toBeDisabled();
    await expect(reason).toContainText(/to add a pin: enter survey id/i);

    // the same spot again: switched off until the pin moves; then the typed entry counts as the third pin
    await page.fill("#surveyIdInput", "S-3");
    await expect(reason).toContainText(/already pinned - move the pin/i);
    await expect(up).toBeDisabled();
    await expect(save).toBeDisabled();
    await page.evaluate(() => updateDisplay(13.76, 100.53));
    await expect(up).toContainText("UPLOAD 3 PINS");
    await expect(save).toBeEnabled();
    await expect(reason).toBeHidden();

    // a Survey ID this worker already recorded
    await page.fill("#surveyIdInput", "S-1");
    await expect(reason).toContainText("Survey ID S-1 is already recorded for 0861");
    await expect(up).toBeDisabled();
    await checkA11y(page, "buttons off with a reason");

    // the admin closes the project while the worker is on it
    await page.evaluate(() => { projectConfigs.Beta = { ...projectConfigs.Beta, isClosed: true }; updateClosedProjectState(); });
    await expect(up).toContainText("PROJECT CLOSED");
    await expect(up).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(reason).toContainText(/project is closed/i);

    // reload: the Employee ID comes back locked; the lock still opens; Home keeps it
    await page.reload();
    await openProject(page, "Beta");
    await expect(eid).toHaveValue("0861");
    await expect(eid).toBeDisabled();
    await expect(up).toContainText("UPLOAD 2 PINS");
    await page.click("#lockEmployeeIdBtn");
    await expect(eid).toBeEnabled();
    await eid.fill("0999");
    await eid.blur();
    await expect(eid).toBeDisabled();
    await page.click("#home-button");
    await openProject(page, "Alpha");
    await expect(eid).toHaveValue("0999");
    await page.reload();
    await openProject(page, "Alpha");
    await expect(eid).toHaveValue("0999");
    await noErrors(page);
  });

  test("no signal: the record waits on the device and goes out later", async ({ page }) => {
    await openProject(page, "Beta");
    await page.locator("#map").click({ position: { x: 100, y: 100 } });
    await page.fill("#employeeIdInput", "0861"); await page.fill("#surveyIdInput", "S-201");
    db.offline = true;
    await page.click("#uploadButton");
    await expect(toast(page)).toContainText(/upload failed/i, { timeout: 15000 });
    await expect(toast(page)).toContainText(/kept on this phone/i);
    await expect(page.locator("#savedLocationsTableBody tr", { hasText: "S-201" })).toContainText("⏳");
    // the honest counter stays until the queue is empty
    await expect(page.locator("#sync-status")).toBeVisible();
    await expect(page.locator("#sync-status")).toContainText(/1 record waiting on this phone/i);
    await expect(page.locator("#uploadButton")).toContainText("UPLOAD 1 PIN");
    await expect(page.locator("#sync-retry-btn")).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(page.locator("#sync-status")).toBeVisible();          // long after the toast is gone
    db.offline = false;
    await page.reload();
    await openProject(page, "Beta");
    await expect(page.locator("#savedLocationsTableBody tr", { hasText: "S-201" })).toContainText("⏳");
    await expect(page.locator("#sync-status")).toContainText(/1 record waiting/i);
    // the phone reports "no connection": the strip says so
    await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true }); window.dispatchEvent(new Event("offline")); });
    await expect(page.locator("#sync-status")).toContainText(/no connection/i);
    await expect(page.locator("#sync-retry-btn")).toBeHidden();
    // back online: the record goes out without a press
    await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true }); window.dispatchEvent(new Event("online")); });
    await expect.poll(() => db.rows.Beta.some(r => r.SurveyID === "S-201"), { timeout: 15000 }).toBe(true);
    await expect(page.locator("#savedLocationsTableBody tr", { hasText: "S-201" })).not.toContainText("⏳");
    await expect(page.locator("#sync-status")).toBeHidden();
    await expect(page.locator("#uploadButton")).toHaveText(/^\s*UPLOAD\s*$/);
    await noErrors(page);
  });

  test("admin screens are locked behind Google sign-in", async ({ page }) => {
    await page.click("#manage-projects-btn");
    await expect(page.locator("#passwordModal")).toBeVisible();
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#passwordModal")).toBeHidden();
    await page.click("#manage-projects-btn");
    await expect(page.locator("#passwordModal")).toBeVisible();
    await checkA11y(page, "sign-in window");
    await page.evaluate(() => { window.__gisToken = "tok-denied"; });
    await page.click("#fake-google-btn");
    await expect(page.locator("#google-signin-note")).toContainText("stranger@gmail.com");
    await expect(page.locator("#project-selection-view")).toBeVisible();
    await page.evaluate(() => { window.__gisToken = "tok-allowed"; });
    await page.click("#fake-google-btn");
    await expect(page.locator("#admin-menu-view")).toBeVisible();
    await expect(page.locator("#admin-account-email")).toHaveText("admin@example.com");
    await noErrors(page);
  });
});

test.describe("admin", () => {
  let db;
  test.beforeEach(async ({ page }) => {
    db = createDb(); await installFakeBackend(page, db, { signedIn: true });
    await page.goto("/"); await expect(page.locator(".figma-project-card").first()).toBeVisible();
    await page.click("#manage-projects-btn"); await expect(page.locator("#admin-menu-view")).toBeVisible();
  });

  test("console, projects, settings and the map picker", async ({ page }) => {
    await checkA11y(page, "admin console");
    await page.click("#goto-manage-projects-btn");
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-project-list .project-admin-item")).toHaveCount(3);
    await checkA11y(page, "manage projects");

    await page.fill("#new-project-name", "Delta");
    await page.click("#add-project-form button[type=submit]");
    await expect(page.locator("#admin-project-list .project-admin-item", { hasText: "Delta" })).toBeVisible();
    expect(db.posts.find(p => p.action === "addProject")).toMatchObject({ projectName: "Delta", session: "sess-1" });

    await page.locator("#admin-project-list .project-admin-item", { hasText: "Alpha" }).locator('button[title="Project settings"]').click();
    await expect(page.locator("#projectConfigModal")).toBeVisible();
    await checkA11y(page, "project settings");
    await page.fill('#projectConfigModal [data-config-field="baseLat"]', "13.7563");
    await page.click("#project-config-save");
    await expect(toast(page)).toContainText(/both latitude and longitude/i);
    await page.click("#project-config-pick-map");
    await expect(page.locator("#adminMapPickerModal")).toBeVisible();
    await checkA11y(page, "map picker");
    await page.fill("#adminMapSearchInput", "somewhere");
    await page.click("#adminMapSearchButton");
    await expect(page.locator("#admin-map-picker-lat")).toHaveValue("13.900000");
    await page.click("#admin-map-picker-apply");
    await expect(page.locator('#projectConfigModal [data-config-field="baseLng"]')).toHaveValue("100.600000");
    await page.fill('#projectConfigModal [data-config-field="radiusKm"]', "10, 3 5");
    await page.click("#project-config-save");
    await expect(page.locator("#projectConfigModal")).toBeHidden();
    const saved = db.posts.find(p => p.action === "updateProjectConfig");
    expect(saved.config).toMatchObject({ baseLat: 13.9, baseLng: 100.6, radiusKms: [3, 5, 10], isClosed: false });
    await expect(page.locator("#admin-project-list .project-admin-item", { hasText: "Alpha" }).locator(".lt-chip", { hasText: "3, 5, 10 km" })).toBeVisible();
    await noErrors(page);
  });

  test("analytics draws every pin of a big project", async ({ page }) => {
    db.rows.Beta = Array.from({ length: 120 }, (_, i) => ({ EmployeeID: "861", SurveyID: String(i), Latitude: 13.7465 + (i % 12) * 0.001, Longitude: 100.5348 + Math.floor(i / 12) * 0.001,
      Timestamp: new Date(Date.UTC(2026, 8, 1) + i * 3600e3).toISOString(), OutOfRadius: false, ID: i + 2 }));
    await page.click("#goto-dashboards-btn");
    await page.selectOption("#dashboard-project-selector", "Beta");
    await expect(page.locator("#kpi-total-checkins")).toHaveText("120");
    await expect(page.locator("#dashboard-map .marker-cluster")).toHaveCount(0);
    await expect(page.locator("#dashboard-map .leaflet-marker-pane img")).toHaveCount(120);
    await expect(page.locator("#dashboard-map .lt-building-marker")).toHaveCount(1);
    await noErrors(page);
  });

  test("analytics shows the circles and pin details", async ({ page }) => {
    await page.click("#goto-dashboards-btn");
    await expect(page.locator("#dashboard-view")).toBeVisible();
    await page.selectOption("#dashboard-project-selector", "Beta");
    await expect(page.locator("#kpi-total-checkins")).toHaveText("3");
    await expect(page.locator("#dashboard-map .lt-building-marker")).toHaveCount(1);
    await expect(page.locator("#dashboard-map .leaflet-overlay-pane path")).toHaveCount(3);
    await checkA11y(page, "analytics");
    await page.evaluate(() => { dashboardMarkers.eachLayer(l => { if (l.getLatLng && l.options.icon && !l.options.icon.options.html && Math.abs(l.getLatLng().lat - 13.7465) < 1e-6) l.openPopup(); }); });
    await expect(page.locator("#dashboard-map .leaflet-popup-content")).toContainText(/Employee ID: 861/);
    await expect(page.locator("#dashboard-map .leaflet-popup-content")).toContainText(/From main coordinate/);
    await noErrors(page);
  });

  test("admins page: list, add, remove", async ({ page }) => {
    await page.click("#goto-admins-btn");
    await expect(page.locator("#admins-view")).toBeVisible();
    await expect(page.locator(".lt-admin-row")).toHaveCount(2);
    await expect(page.locator(".lt-admin-row", { hasText: "owner@example.com" })).toContainText("(owner)");
    await expect(page.locator(".lt-admin-row", { hasText: "admin@example.com" })).toContainText("(you)");
    await expect(page.locator(".lt-admin-row button")).toHaveCount(0);          // nobody can remove the owner or themselves
    await expect(page.locator(".lt-admin-note")).toContainText(/test user/i);
    await checkA11y(page, "admins page");
    await page.fill("#new-admin-email", "not-an-email");
    await page.click("#add-admin-form button[type=submit]");
    expect(db.posts.filter(p => p.action === "addAdmin")).toHaveLength(0);      // the browser asks for a real email first
    await page.fill("#new-admin-email", "Friend@Gmail.com");
    await page.click("#add-admin-form button[type=submit]");
    await expect(page.locator(".lt-admin-row", { hasText: "friend@gmail.com" })).toBeVisible();
    expect(db.posts.find(p => p.action === "addAdmin")).toMatchObject({ email: "friend@gmail.com", session: "sess-1" });
    await expect(page.locator("#new-admin-email")).toHaveValue("");
    await page.fill("#new-admin-email", "friend@gmail.com");
    await page.click("#add-admin-form button[type=submit]");
    await expect(toast(page)).toContainText(/already an admin/i);
    await page.locator(".lt-admin-row", { hasText: "friend@gmail.com" }).getByRole("button", { name: /remove admin/i }).click();
    await expect(page.locator("#confirmationModal")).toBeVisible();
    await page.click("#confirmActionButton");
    await expect(page.locator(".lt-admin-row", { hasText: "friend@gmail.com" })).toHaveCount(0);
    expect(db.admins.map(a => a.email)).toEqual(["owner@example.com", "admin@example.com"]);
    await noErrors(page);
  });

  test("manage projects: move up / down without dragging", async ({ page }) => {
    await page.click("#goto-manage-projects-btn");
    const names = () => page.locator("#admin-project-list .project-admin-item").evaluateAll(rows => rows.map(r => r.dataset.projectName));
    expect(await names()).toEqual(["Alpha", "Beta", "Gamma"]);
    await expect(page.getByRole("button", { name: "Move Alpha up" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Move Gamma down" })).toBeDisabled();
    await page.getByRole("button", { name: "Move Gamma up" }).focus();
    await page.keyboard.press("Enter");
    expect(await names()).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(await page.evaluate(() => document.activeElement.getAttribute("aria-label"))).toBe("Move Gamma up");   // focus follows the row
    await page.keyboard.press("Enter");
    expect(await names()).toEqual(["Gamma", "Alpha", "Beta"]);
    await expect(page.locator("#save-project-order-btn")).toBeVisible();
    await page.click("#save-project-order-btn");
    await expect.poll(() => db.posts.filter(p => p.action === "reorderProjects").length).toBe(1);
    expect(db.posts.find(p => p.action === "reorderProjects")).toMatchObject({ projectOrder: ["Gamma", "Alpha", "Beta"], session: "sess-1" });
    await noErrors(page);
  });

  test("requests from the field and shared labels", async ({ page }) => {
    db.reports.push({ ID: 2, Timestamp: new Date(Date.now() - 3600e3).toISOString(), Project: "Beta", EmployeeID: "861", SurveyID: "001", Latitude: 13.7465, Longitude: 100.5348, RecordTimestamp: new Date().toISOString(), Request: "delete", RequestText: "Delete this record", Note: "pressed twice", ReportedBy: "861", status: "open" });
    db.reports.push({ ID: 3, Timestamp: new Date().toISOString(), Project: "Alpha", EmployeeID: "781", SurveyID: "009", Latitude: 13.7465, Longitude: 100.5348, RecordTimestamp: new Date().toISOString(), Request: "wrong_location", RequestText: "Wrong location", Note: "", ReportedBy: "781", status: "open" });
    await page.click("#menu-back-to-selection-btn");
    await page.click("#manage-projects-btn");
    await expect(page.locator("#requests-badge")).toHaveText("2");
    await page.click("#goto-requests-btn");
    await expect(page.locator("#requests-view")).toBeVisible();
    await expect(page.locator(".lt-request")).toHaveCount(2);
    await expect(page.locator(".lt-request").first()).toContainText(/Wrong location/);       // newest first
    await page.selectOption("#requests-order", "oldest");
    await expect(page.locator(".lt-request").first()).toContainText(/Delete this record/);
    await expect(page.locator("#requests-project option")).toHaveText(["All projects", "Alpha (1)", "Beta (1)"]);
    await page.selectOption("#requests-project", "Beta");
    await expect(page.locator(".lt-request")).toHaveCount(1);
    await expect(page.locator(".lt-request")).toContainText(/Delete this record/);
    await checkA11y(page, "requests");
    await page.click(".lt-request-done");
    await expect(page.locator(".lt-request")).toHaveCount(1);                                 // the Beta one is done; filter falls back to all
    await expect(page.locator("#requests-project")).toHaveValue("");
    await expect(page.locator(".lt-request")).toContainText(/Wrong location/);
    await expect(page.locator("#requests-badge")).toHaveText("1");
    expect(db.posts.find(p => p.action === "resolveReport")).toMatchObject({ id: 2, session: "sess-1" });

    await page.click("#requests-back-to-menu-btn");
    await page.click("#customizeLabelsBtn");
    await expect(page.locator("#customizeLabelsModal")).toBeVisible();
    await checkA11y(page, "field labels");
    await page.fill("#custom-employee-label", "Staff code");
    await page.click("#customize-labels-form button[type=submit]");
    await expect(page.locator("#customizeLabelsModal")).toBeHidden();
    expect(db.labels.employeeId).toBe("Staff code");
    await page.click("#menu-back-to-selection-btn");
    await openProject(page, "Beta");
    await expect(page.locator("#employeeIdLabel")).toHaveText("Staff code");
    await expect(page.locator("#tracker-view #customizeLabelsBtn")).toHaveCount(0);
    await noErrors(page);
  });
});
