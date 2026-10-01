// Runs Code.gs against an in-memory fake of SpreadsheetApp (no Google calls).
// Usage: node apps-script/test-code-gs.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "Code.gs"), "utf8");

function makeSheet(name) {
  const s = {
    name, hidden: false, rows: [], formats: {},
    getName: () => s.name, setName: n => { s.name = n; },
    isSheetHidden: () => s.hidden, hideSheet: () => { s.hidden = true; },
    appendRow: r => { s.rows.push([...r]); },
    getLastRow: () => s.rows.length,
    getLastColumn: () => s.rows.reduce((m, r) => Math.max(m, r.length), 0),
    deleteRow: i => { s.rows.splice(i - 1, 1); },
    getDataRange: () => rangeOf(s, 1, 1, s.rows.length, s.getLastColumn()),
    getRange: (a, b, c, d) => {
      if (typeof a === "string") return { setNumberFormat: f => { s.formats[a] = f; } };
      return rangeOf(s, a, b, c ?? 1, d ?? 1);
    },
  };
  return s;
}
function rangeOf(s, row, col, nr, nc) {
  const r = {
    getNumRows: () => nr, getNumColumns: () => nc,
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.rows[row - 1 + i] || [])[col - 1 + j] ?? "")),
    setValues: v => v.forEach((line, i) => line.forEach((x, j) => { const rr = s.rows[row - 1 + i] ||= []; rr[col - 1 + j] = x; })),
    setValue: x => r.setValues([[x]]),
    offset: (dr, dc, nr2, nc2) => rangeOf(s, row + dr, col + dc, nr2, nc2),
  };
  return r;
}
function makeSpreadsheet() {
  const ss = { sheets: [makeSheet("Sheet1")], active: null };
  Object.assign(ss, {
    getSheets: () => ss.sheets,
    getSheetByName: n => ss.sheets.find(x => x.name === n) || null,
    insertSheet: n => { const x = makeSheet(n); ss.sheets.push(x); return x; },
    setActiveSheet: x => { ss.active = x; },
    moveActiveSheet: pos => { ss.sheets.splice(ss.sheets.indexOf(ss.active), 1); ss.sheets.splice(pos - 1, 0, ss.active); },
  });
  return ss;
}

function load(props = {}) {
  const ss = makeSpreadsheet();
  const slackCalls = [];
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch: (u, o) => slackCalls.push(JSON.parse(o.payload).text) },
    Logger: { log() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const get = q => JSON.parse(ctx.doGet({ parameter: q }).text);
  const post = b => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  return { ss, get, post, slackCalls, props };
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) pass++; else { fail++; console.log("FAIL:", name, extra); } }

// --- basic flow
{
  const { ss, get, post, slackCalls } = load({ ADMIN_PASSWORD: "pw-test" });
  check("version", get({ action: "version" }).data.version === "v12.0");
  check("addProject", post({ action: "addProject", projectName: "  Alpha  " }).success);
  check("addProject trims name", !!ss.getSheetByName("Alpha"));
  check("duplicate project rejected", post({ action: "addProject", projectName: "Alpha" }).success === false);
  check("empty project name rejected", post({ action: "addProject", projectName: "  " }).success === false);
  check("headers written", ss.getSheetByName("Alpha").rows[0].join() === "EmployeeID,SurveyID,Timestamp,Latitude,Longitude,GoogleMapsLink,OutOfRadius,DistanceKm,RadiusKm,RadiusKms,SlackAlertRequired,SlackMessage");
  post({ action: "addProject", projectName: "Beta" });
  const projects = get({ action: "getProjects" }).data;
  check("getProjects lists visible sheets", projects.includes("Alpha") && projects.includes("Beta"), JSON.stringify(projects));

  const add = post({ action: "add", project: "Alpha", data: { name: "0861", surveyId: "083", lat: 13.7, lng: 100.5, timestamp: "2026-09-21T03:00:00.000Z" } });
  check("add ok", add.success, JSON.stringify(add));
  const rows = get({ action: "getData", project: "Alpha" }).data;
  check("getData returns row", rows.length === 1);
  check("leading zeros kept", rows[0].EmployeeID === "0861" && rows[0].SurveyID === "083", JSON.stringify(rows[0]));
  check("timestamp round-trips", rows[0].Timestamp === "2026-09-21T03:00:00.000Z", rows[0].Timestamp);
  check("maps link", rows[0].GoogleMapsLink === "https://www.google.com/maps?q=13.7,100.5");
  check("row ID = sheet row", rows[0].ID === 2);
  check("add to missing project fails", post({ action: "add", project: "Nope", data: {} }).success === false);
  check("add into ProjectConfigs refused", post({ action: "add", project: "ProjectConfigs", data: {} }).success === false);
  check("Thai d/m/y timestamp parsed", (() => { post({ action: "add", project: "Beta", data: { name: "1", surveyId: "2", lat: 1, lng: 2, timestamp: "21/09/2026, 10:05:00" } }); const t = get({ action: "getData", project: "Beta" }).data[0].Timestamp; return /^2026-09-21T/.test(t); })());

  check("update ok", post({ action: "update", project: "Alpha", id: 2, data: { name: "999", surveyId: "1", lat: 1, lng: 2 } }).success);
  check("update applied", get({ action: "getData", project: "Alpha" }).data[0].EmployeeID === "999");
  check("update header row refused", post({ action: "update", project: "Alpha", id: 1, data: {} }).success === false);
  check("update past last row refused", post({ action: "update", project: "Alpha", id: 50, data: {} }).success === false);
  check("delete header row refused", post({ action: "delete", project: "Alpha", id: 1 }).success === false);
  check("delete ok", post({ action: "delete", project: "Alpha", id: 2 }).success && get({ action: "getData", project: "Alpha" }).data.length === 0);

  check("rename ok", post({ action: "renameProject", oldProjectName: "Beta", newProjectName: "Gamma" }).success && !!ss.getSheetByName("Gamma"));
  check("rename to existing refused", post({ action: "renameProject", oldProjectName: "Gamma", newProjectName: "Alpha" }).success === false);
  check("rename to ProjectConfigs refused", post({ action: "renameProject", oldProjectName: "Gamma", newProjectName: "ProjectConfigs" }).success === false);

  check("reorder ok", post({ action: "reorderProjects", projectOrder: ["Gamma", "Alpha"] }).success);
  check("reorder applied", get({ action: "getProjects" }).data.slice(0, 2).join() === "Gamma,Alpha");
  check("reorder needs array", post({ action: "reorderProjects", projectOrder: "x" }).success === false);

  check("hide ok", post({ action: "hideProject", projectName: "Gamma" }).success);
  check("hidden project not listed", !get({ action: "getProjects" }).data.includes("Gamma"));
  check("hidden data kept", get({ action: "getData", project: "Gamma" }).data.length === 1);

  check("config update", post({ action: "updateProjectConfig", projectName: "Alpha", config: { baseLat: 13.8, baseLng: 100.56, radiusKms: [3, 5, 5] } }).data[0].radiusKms.join() === "3,5");
  check("ProjectConfigs not listed as project", !get({ action: "getProjects" }).data.includes("ProjectConfigs"));
  check("ProjectConfigs cannot be hidden", post({ action: "hideProject", projectName: "ProjectConfigs" }).success === false);
  check("config follows rename", (post({ action: "renameProject", oldProjectName: "Alpha", newProjectName: "Alpha2" }), get({ action: "getProjectConfigs" }).data[0].projectName === "Alpha2"));

  check("verifyPassword right", post({ action: "verifyPassword", password: "pw-test" }).success === true);
  check("verifyPassword wrong", post({ action: "verifyPassword", password: "nope" }).success === false);
  check("slack off without webhook", post({ action: "notifySlackAnomaly", message: "x" }).sent === false && slackCalls.length === 0);
  check("unknown action", /Invalid action/.test(post({ action: "zzz" }).message));
  check("bad GET", get({ action: "zzz" }).success === false);
}

// --- no password configured: nobody unlocks
{
  const { post } = load({});
  check("no ADMIN_PASSWORD -> locked", post({ action: "verifyPassword", password: "" }).success === false && post({ action: "verifyPassword", password: "anything" }).success === false);
}

// --- slack on when webhook set
{
  const { post, slackCalls } = load({ SLACK_WEBHOOK_URL: "https://example.invalid/hook" });
  check("slack sends when set", post({ action: "notifySlackAnomaly", message: "hello" }).sent === true && slackCalls[0] === "hello");
}

// --- no secrets in source
check("no hard-coded password/webhook", !/hooks\.slack\.com|adminPassword\s*=\s*"/.test(src));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
