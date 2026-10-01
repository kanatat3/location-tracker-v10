// Runs Code.gs against an in-memory fake of SpreadsheetApp (no Google calls).
// Usage: node apps-script/test-code-gs.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import crypto from "node:crypto";
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

const OWNER = "owner@example.com";
const CLIENT_ID = "client-1.apps.googleusercontent.com";
const webSafe = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
// Same format as signSession_ in Code.gs, for building expired / forged tokens.
function craftSession(email, expiresAt, secret) {
  const payload = email + "|" + expiresAt;
  return webSafe(Buffer.from(payload)) + "." + webSafe(crypto.createHmac("sha256", secret).update(payload).digest());
}

// By default the fake signs in as the script owner and sends that session with every POST,
// so the admin actions behave as for a signed-in admin; rawPost sends exactly what it is given.
function load(props = {}, { clientId = CLIENT_ID } = {}) {
  if (clientId && props.GOOGLE_CLIENT_ID === undefined) props.GOOGLE_CLIENT_ID = clientId;
  const ss = makeSpreadsheet();
  const slackCalls = [];
  const slackState = { status: 200, throws: false };
  const tokens = {};
  let tokenSeq = 0;
  const issueToken = (email, over = {}) => {
    const id = "tok-" + (++tokenSeq);
    tokens[id] = { status: 200, claims: { aud: CLIENT_ID, iss: "https://accounts.google.com", email, email_verified: "true", exp: String(Math.floor(Date.now() / 1000) + 3600), ...over } };
    return id;
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    UrlFetchApp: {
      fetch: (u, o) => {
        const prefix = "https://oauth2.googleapis.com/tokeninfo?id_token=";
        if (u.startsWith(prefix)) {
          const t = tokens[decodeURIComponent(u.slice(prefix.length))];
          return { getResponseCode: () => (t ? t.status : 400), getContentText: () => JSON.stringify(t ? t.claims : { error: "invalid_token" }) };
        }
        const body = JSON.parse(o.payload);
        slackCalls.push({ url: u, text: body.text ?? body.message, body });
        if (slackState.throws) throw new Error("network down");
        return { getResponseCode: () => slackState.status, getContentText: () => "" };
      },
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac("sha256", key).update(value).digest()).map(b => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: d => webSafe(typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d.map(b => b & 255))),
      base64DecodeWebSafe: t => Array.from(Buffer.from(String(t).replace(/-/g, "+").replace(/_/g, "/"), "base64")),
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes.map(b => b & 255)).toString("utf8") }),
    },
    Logger: { log() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const get = q => JSON.parse(ctx.doGet({ parameter: q }).text);
  const rawPost = b => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(b) } }).text);
  const login = email => rawPost({ action: "googleLogin", idToken: issueToken(email) });
  const session = clientId ? login(OWNER).session : undefined;
  const post = b => rawPost({ session, ...b });
  return { ss, get, post, rawPost, login, issueToken, session, slackCalls, slackState, props };
}

let pass = 0, fail = 0;
function check(name, cond, extra = "") { if (cond) pass++; else { fail++; console.log("FAIL:", name, extra); } }

// --- basic flow
{
  const { ss, get, post, slackCalls } = load();
  check("version", get({ action: "version" }).data.version === "v12.2");
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

  check("verifyPassword always refused", post({ action: "verifyPassword", password: "pw-test" }).success === false && post({ action: "verifyPassword", password: "" }).success === false);
  check("free-text Slack action is retired", post({ action: "notifySlackAnomaly", message: "x" }).sent === false && slackCalls.length === 0);
  check("unknown action", /Invalid action/.test(post({ action: "zzz" }).message));
  check("bad GET", get({ action: "zzz" }).success === false);
}

// --- Google sign-in: who gets in
{
  const { ss, get, rawPost, login, issueToken, session } = load();
  const tab = ss.getSheetByName("AllowedEmails");
  check("AllowedEmails tab created with the owner", !!tab && tab.rows[0][0] === "Email" && tab.rows[1][0] === OWNER, JSON.stringify(tab && tab.rows));
  check("owner login gives a session", typeof session === "string" && session.includes("."));
  check("login reply has email + expiry", (() => { const r = login(OWNER); return r.success && r.email === OWNER && r.expiresAt > Date.now() + 29 * 864e5; })());
  check("email match ignores case and spaces", rawPost({ action: "googleLogin", idToken: issueToken("  Owner@Example.COM ") }).success === true);

  const stranger = login("stranger@gmail.com");
  check("email not in the list is refused", stranger.success === false && !stranger.session && /stranger@gmail\.com/.test(stranger.message), JSON.stringify(stranger));
  tab.appendRow(["  Friend@Gmail.com ", "added by hand"]);
  const friend = login("friend@gmail.com");
  check("email added to the tab gets in", friend.success === true);
  check("friend session works", rawPost({ action: "addProject", projectName: "ByFriend", session: friend.session }).success === true);
  tab.rows.splice(2, 1);
  const afterRemoval = rawPost({ action: "addProject", projectName: "ByFriend2", session: friend.session });
  check("removing the email ends that session at once", afterRemoval.success === false && afterRemoval.authRequired === true && !ss.getSheetByName("ByFriend2"));

  const bad = (name, over) => check(name, rawPost({ action: "googleLogin", idToken: issueToken(OWNER, over) }).success === false);
  bad("token for another app refused", { aud: "someone-else.apps.googleusercontent.com" });
  bad("unverified email refused", { email_verified: "false" });
  bad("expired Google token refused", { exp: String(Math.floor(Date.now() / 1000) - 10) });
  bad("wrong issuer refused", { iss: "https://evil.example" });
  check("unknown Google token refused", rawPost({ action: "googleLogin", idToken: "made-up" }).success === false);
  check("missing Google token refused", rawPost({ action: "googleLogin" }).success === false);

  // admin actions need the session; saving a point does not
  rawPost({ action: "addProject", projectName: "Open", session });
  for (const body of [
    { action: "addProject", projectName: "NoAuth" },
    { action: "renameProject", oldProjectName: "Open", newProjectName: "Renamed" },
    { action: "hideProject", projectName: "Open" },
    { action: "deleteProject", projectName: "Open" },
    { action: "reorderProjects", projectOrder: ["Open"] },
    { action: "updateProjectConfig", projectName: "Open", config: {} },
    { action: "update", project: "Open", id: 2, data: {} },
    { action: "delete", project: "Open", id: 2 },
  ]) {
    const r = rawPost(body);
    check(body.action + " without sign-in refused", r.success === false && r.authRequired === true, JSON.stringify(r));
  }
  check("nothing changed without sign-in", !ss.getSheetByName("NoAuth") && !ss.getSheetByName("Renamed") && !ss.getSheetByName("Open").hidden);
  check("saving a point needs no sign-in", rawPost({ action: "add", project: "Open", data: { name: "1", surveyId: "2", lat: 1, lng: 2 } }).success === true);
  check("reading needs no sign-in", get({ action: "getData", project: "Open" }).data.length === 1 && get({ action: "getProjects" }).success);

  check("garbage session refused", rawPost({ action: "addProject", projectName: "X1", session: "abc" }).authRequired === true && rawPost({ action: "addProject", projectName: "X1", session: "a.b" }).authRequired === true && rawPost({ action: "addProject", projectName: "X1", session: 5 }).authRequired === true);
  const [, sig] = session.split(".");
  const forged = webSafe(Buffer.from("stranger@gmail.com|" + (Date.now() + 864e5))) + "." + sig;
  check("session with a swapped email refused", rawPost({ action: "addProject", projectName: "X2", session: forged }).authRequired === true);

  // the tab is not a project
  check("AllowedEmails not listed as project", !get({ action: "getProjects" }).data.includes("AllowedEmails"));
  check("AllowedEmails not readable as project", get({ action: "getData", project: "AllowedEmails" }).success === false);
  check("cannot save a point into AllowedEmails", rawPost({ action: "add", project: "AllowedEmails", data: {} }).success === false);
  check("AllowedEmails cannot be hidden / renamed / reused", rawPost({ action: "hideProject", projectName: "AllowedEmails", session }).success === false
    && rawPost({ action: "renameProject", oldProjectName: "AllowedEmails", newProjectName: "Z", session }).success === false
    && rawPost({ action: "renameProject", oldProjectName: "Open", newProjectName: "AllowedEmails", session }).success === false
    && rawPost({ action: "addProject", projectName: "AllowedEmails", session }).success === false
    && tab.name === "AllowedEmails" && !tab.hidden);
  rawPost({ action: "reorderProjects", projectOrder: ["AllowedEmails", "Open"], session });
  check("reorder leaves AllowedEmails alone", ss.sheets[0].name !== "AllowedEmails");
}

// --- sessions: expiry and signing key
{
  const secret = "test-secret";
  const { rawPost } = load({ SESSION_SECRET: secret });
  check("valid crafted session accepted", rawPost({ action: "addProject", projectName: "S1", session: craftSession(OWNER, Date.now() + 60000, secret) }).success === true);
  check("expired session refused", rawPost({ action: "addProject", projectName: "S2", session: craftSession(OWNER, Date.now() - 1000, secret) }).authRequired === true);
  check("session signed with another key refused", rawPost({ action: "addProject", projectName: "S3", session: craftSession(OWNER, Date.now() + 60000, "other") }).authRequired === true);
  check("session for an email outside the list refused", rawPost({ action: "addProject", projectName: "S4", session: craftSession("stranger@gmail.com", Date.now() + 60000, secret) }).authRequired === true);
}

// --- sign-in not configured: nobody gets in
{
  const { rawPost, issueToken, props } = load({}, { clientId: null });
  const r = rawPost({ action: "googleLogin", idToken: issueToken(OWNER) });
  check("no GOOGLE_CLIENT_ID -> locked", r.success === false && /not set up/.test(r.message), JSON.stringify(r));
  check("signing key is generated, not hard-coded", (rawPost({ action: "addProject", projectName: "Q", session: "a.b" }), typeof props.SESSION_SECRET === "string" && props.SESSION_SECRET.length >= 32));
}

// --- project settings: main coordinate, radius circles, closed
const BASE = { baseLat: 13.7563, baseLng: 100.5018 };          // Bangkok
const INSIDE = { lat: 13.7650, lng: 100.5380 };                 // ~4 km away
const OUTSIDE = { lat: 13.9000, lng: 100.5018 };                // ~16 km away
{
  const { ss, get, post, rawPost, slackCalls } = load({ SLACK_WEBHOOK_URL: "https://example.invalid/hook" });
  post({ action: "addProject", projectName: "Site" });
  post({ action: "addProject", projectName: "Free" });

  check("no settings yet: no limit, not closed", get({ action: "getProjectConfigs" }).data.length === 0);
  const saved = post({ action: "updateProjectConfig", projectName: "Site", config: { ...BASE, radiusKms: "10, 3 5", isClosed: false } });
  const cfg = saved.data.find(c => c.projectName === "Site");
  check("several circles kept, sorted", cfg.radiusKms.join() === "3,5,10" && cfg.radiusKm === 10 && cfg.baseLat === BASE.baseLat && cfg.isClosed === false, JSON.stringify(cfg));
  check("getProjects carries the settings", (() => { const r = get({ action: "getProjects" }); return r.data.includes("Site") && r.configs.find(c => c.projectName === "Site").radiusKm === 10; })());
  check("settings need sign-in", rawPost({ action: "updateProjectConfig", projectName: "Site", config: { isClosed: true } }).authRequired === true);
  check("settings for an unknown project refused", post({ action: "updateProjectConfig", projectName: "Nope", config: {} }).success === false
    && post({ action: "updateProjectConfig", projectName: "AllowedEmails", config: {} }).success === false);
  check("half a coordinate refused", post({ action: "updateProjectConfig", projectName: "Site", config: { baseLat: 13.7 } }).success === false);
  check("impossible coordinate refused", post({ action: "updateProjectConfig", projectName: "Site", config: { baseLat: 130, baseLng: 100 } }).success === false
    && post({ action: "updateProjectConfig", projectName: "Site", config: { baseLat: "abc", baseLng: 100 } }).success === false);
  check("refused settings left the saved ones alone", get({ action: "getProjectConfigs" }).data.find(c => c.projectName === "Site").radiusKm === 10);

  // a pin inside the widest circle
  const inside = rawPost({ action: "add", project: "Site", data: { name: "0861", surveyId: "001", ...INSIDE } });
  check("pin inside the radius: saved, no alert", inside.success && inside.outOfRadius === false && inside.slackSent === false && slackCalls.length === 0, JSON.stringify(inside));
  let row = get({ action: "getData", project: "Site" }).data[0];
  check("inside row is measured by the server", row.OutOfRadius === false && row.DistanceKm > 3.5 && row.DistanceKm < 4.5 && row.RadiusKm === 10 && row.RadiusKms.join() === "3,5,10" && row.SlackAlertRequired === false, JSON.stringify(row));

  // a pin outside, with the page claiming it is fine
  const outside = rawPost({ action: "add", project: "Site", data: { name: "0861", surveyId: "002", ...OUTSIDE, outOfRadius: false, distanceKm: 0.1, slackAlertRequired: false } });
  check("pin outside the radius: saved and flagged whatever the page claims", outside.success && outside.outOfRadius === true && outside.distanceKm > 15 && outside.distanceKm < 17 && outside.radiusKm === 10, JSON.stringify(outside));
  row = get({ action: "getData", project: "Site" }).data[1];
  check("outside row marked in the Sheet", row.OutOfRadius === true && row.DistanceKm > 15 && row.SlackAlertRequired === true && /0861/.test(row.SlackMessage) && /002/.test(row.SlackMessage), JSON.stringify(row));
  check("Slack alert sent once with project, IDs, distance", outside.slackSent === true && slackCalls.length === 1 && slackCalls[0].url === "https://example.invalid/hook"
    && /Project: Site/.test(slackCalls[0].text) && /Employee ID: 0861/.test(slackCalls[0].text) && /Survey ID: 002/.test(slackCalls[0].text) && /Max Radius: 10\.00 km/.test(slackCalls[0].text), JSON.stringify(slackCalls));

  // a project without settings keeps working as before
  const free = rawPost({ action: "add", project: "Free", data: { name: "1", surveyId: "2", ...OUTSIDE } });
  check("project without a main coordinate: no limit, no alert", free.success && free.outOfRadius === false && slackCalls.length === 1 && get({ action: "getData", project: "Free" }).data[0].RadiusKms.length === 0);
  post({ action: "updateProjectConfig", projectName: "Free", config: { ...BASE, radiusKms: "" } });
  check("main coordinate without a radius: still no limit", rawPost({ action: "add", project: "Free", data: { name: "1", surveyId: "3", ...OUTSIDE } }).outOfRadius === false && slackCalls.length === 1);

  // bad coordinates never reach the Sheet
  const before = ss.getSheetByName("Site").rows.length;
  check("pin without a usable coordinate refused", rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "9" } }).success === false
    && rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "9", lat: "x", lng: 100 } }).success === false
    && rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "9", lat: 95, lng: 100 } }).success === false
    && rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "9", lat: "", lng: "" } }).success === false
    && ss.getSheetByName("Site").rows.length === before);

  // closing a project
  post({ action: "updateProjectConfig", projectName: "Site", config: { ...BASE, radiusKms: [3, 5, 10], isClosed: true } });
  const closed = rawPost({ action: "add", project: "Site", data: { name: "0861", surveyId: "003", ...INSIDE } });
  check("closed project accepts no new pins", closed.success === false && /closed/i.test(closed.message) && ss.getSheetByName("Site").rows.length === before, JSON.stringify(closed));
  check("closed project can still be read", get({ action: "getData", project: "Site" }).data.length === 2 && get({ action: "getProjects" }).data.includes("Site"));
  post({ action: "updateProjectConfig", projectName: "Site", config: { ...BASE, radiusKms: [3, 5, 10], isClosed: false } });
  check("reopened project accepts pins again", rawPost({ action: "add", project: "Site", data: { name: "0861", surveyId: "003", ...INSIDE } }).success === true);
  check("settings follow a rename", (post({ action: "renameProject", oldProjectName: "Site", newProjectName: "Site 2" }), rawPost({ action: "add", project: "Site 2", data: { name: "1", surveyId: "4", ...OUTSIDE } }).outOfRadius === true));
}

// --- Slack destinations and failures
{
  const { post, rawPost, slackCalls } = load({});
  post({ action: "addProject", projectName: "Site" });
  post({ action: "updateProjectConfig", projectName: "Site", config: { ...BASE, radiusKms: [5] } });
  const r = rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "1", ...OUTSIDE } });
  check("no Slack destination set: pin saved, alert marked as not sent", r.success && r.outOfRadius === true && r.slackSent === false && slackCalls.length === 0);
}
{
  const { post, rawPost, slackCalls } = load({ SLACK_ALERT_URL: "https://example.invalid/relay", SLACK_ALERT_SECRET: "s3cret" });
  post({ action: "addProject", projectName: "Site" });
  post({ action: "updateProjectConfig", projectName: "Site", config: { ...BASE, radiusKms: [5] } });
  const r = rawPost({ action: "add", project: "Site", data: { name: "7", surveyId: "8", ...OUTSIDE } });
  check("relay destination gets the alert with its secret", r.slackSent === true && slackCalls.length === 1 && slackCalls[0].url === "https://example.invalid/relay"
    && slackCalls[0].body.secret === "s3cret" && slackCalls[0].body.action === "notifySlackAnomaly" && slackCalls[0].body.project === "Site" && /Employee ID: 7/.test(slackCalls[0].text), JSON.stringify(slackCalls));
}
{
  const { ss, post, rawPost, slackCalls, slackState } = load({ SLACK_WEBHOOK_URL: "https://example.invalid/hook" });
  post({ action: "addProject", projectName: "Site" });
  post({ action: "updateProjectConfig", projectName: "Site", config: { ...BASE, radiusKms: [5] } });
  slackState.status = 500;
  const a = rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "1", ...OUTSIDE } });
  slackState.throws = true;
  const b = rawPost({ action: "add", project: "Site", data: { name: "1", surveyId: "2", ...OUTSIDE } });
  check("Slack trouble never loses the pin", a.success && a.slackSent === false && b.success && b.slackSent === false && ss.getSheetByName("Site").rows.length === 3 && slackCalls.length === 2);
}

// --- no secrets in source
check("no hard-coded password/webhook", !/hooks\.slack\.com|adminPassword\s*=\s*"|script\.google\.com\/macros/.test(src));
check("no admin password or hard-coded email left", !/ADMIN_PASSWORD/.test(src) && !/[\w.]+@[\w-]+\.\w+/.test(src));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
