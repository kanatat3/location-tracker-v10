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
    await page.click("#uploadButton");
    await expect(toast(page)).toContainText(/tap the map to set the location/i);
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
    await page.click("#uploadButton");
    await expect(toast(page)).toContainText(/enter employee id and survey id/i);
    await page.fill("#employeeIdInput", "0861");
    await page.fill("#surveyIdInput", "S-101");
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
    await expect(page.locator("#uploadButton")).toContainText("UPLOAD (1)");
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

  test("requests from the field and shared labels", async ({ page }) => {
    db.reports.push({ ID: 2, Timestamp: new Date().toISOString(), Project: "Beta", EmployeeID: "861", SurveyID: "001", Latitude: 13.7465, Longitude: 100.5348, RecordTimestamp: new Date().toISOString(), Request: "delete", RequestText: "Delete this record", Note: "pressed twice", ReportedBy: "861", status: "open" });
    await page.click("#menu-back-to-selection-btn");
    await page.click("#manage-projects-btn");
    await expect(page.locator("#requests-badge")).toHaveText("1");
    await page.click("#goto-requests-btn");
    await expect(page.locator("#requests-view")).toBeVisible();
    await expect(page.locator(".lt-request")).toHaveCount(1);
    await expect(page.locator(".lt-request")).toContainText(/Delete this record/);
    await checkA11y(page, "requests");
    await page.click(".lt-request-done");
    await expect(page.locator(".lt-request")).toHaveCount(0);
    await expect(page.locator("#requests-empty")).toBeVisible();
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
