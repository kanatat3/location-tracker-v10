// A fake of the Apps Script backend (Code.gs v12.3) plus a fake Google sign-in, wired into a Playwright page.
// Nothing reaches Google or the real Sheet: every call to script.google.com is answered here.
export const BASE = { lat: 13.7465, lng: 100.5348 };          // Beta's main coordinate (Bangkok)
export const OUTSIDE = { lat: 13.92, lng: 100.5348 };          // ~19 km north of it

const km = (a, b, c, d) => { const r = v => v * Math.PI / 180; const x = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); };
// Fake place search, shaped like the real answers seen on 2026-10-14: Photon forgives typos but misses
// some exact Thai names; Nominatim knows exact names but nothing misspelled. Unknown Nominatim queries
// answer "Somewhere, Bangkok"; "ไม่มีที่นี่" finds nothing anywhere.
const feature = (name, lat, lng, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { name, countrycode: "TH", district: "ปทุมวัน", state: "กรุงเทพมหานคร", ...props } });
export const GEO = {
  photon: {
    "เซนทรัลเวิล": [feature("เซ็นทรัลเวิลด์", 13.7468, 100.5393), feature("เซ็นทรัลเวิลด์สแควร์", 13.7470, 100.5400)],
    "เซ็นทรัลเวิลด์": [feature("เซ็นทรัลเวิลด์", 13.7468, 100.5393)],
    // two branches with the same kind of name: Photon lists the far one (Chiang Mai) first
    "7-11 ลาดพร้าว": [feature("7-11 ลาดพร้าว ซอย 1 เชียงใหม่", 18.79, 98.98), feature("7-11 ลาดพร้าว 101", 13.79, 100.61)],
    "evil": [feature('<img src=x onerror="window.__xss=1">Evil Mall', 13.75, 100.5)],
    "เชียงใหม่": [feature("เชียงใหม่", 18.7883, 98.9853, { district: "", state: "จังหวัดเชียงใหม่", extent: [98.9, 18.85, 99.05, 18.7] })],
  },
  nominatim: {
    "สยามพารากอน": [{ lat: "13.7461", lon: "100.5348", name: "สยามพารากอน", display_name: "สยามพารากอน, 991, ถนนพระรามที่ 1, แขวงปทุมวัน, เขตปทุมวัน, กรุงเทพมหานคร, 10330, ประเทศไทย" }],
    "สยามพารากอล": [], "เซนทรัลเวิล": [], "ไม่มีที่นี่": [], "evil": [],
  },
};
const REQUESTS = { delete: "Delete this record", wrong_employee: "Wrong Employee ID", wrong_survey: "Wrong Survey ID", wrong_location: "Wrong location", other: "Other" };

export function createDb() {
  return {
    validSession: "sess-1",
    allowed: ["admin@example.com"],
    projects: ["Alpha", "Beta", "Gamma"],
    configs: [
      { projectName: "Beta", baseLat: BASE.lat, baseLng: BASE.lng, radiusKms: [3, 5, 10], radiusKm: 10, isClosed: false },
      { projectName: "Gamma", baseLat: null, baseLng: null, radiusKms: [], radiusKm: null, isClosed: true },
    ],
    labels: { employeeId: "Employee ID", surveyId: "Survey ID" },
    rows: {
      Alpha: [], Gamma: [],
      Beta: [0, 1, 2].map(i => ({ EmployeeID: ["861", "781", "864"][i], SurveyID: "00" + (i + 1), Latitude: BASE.lat + i * 0.002, Longitude: BASE.lng + i * 0.002,
        Timestamp: new Date(Date.UTC(2026, 8, 29, 2 + i, 15)).toISOString(), OutOfRadius: false, DistanceKm: 0, RadiusKm: 10, RadiusKms: [3, 5, 10], ID: i + 2 })),
    },
    reports: [],
    admins: [{ email: "owner@example.com", note: "owner (added automatically)", owner: true }, { email: "admin@example.com", note: "", owner: false }],
    posts: [],
  };
}

function handle(db, method, url, body) {
  const json = o => ({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  const refused = json({ success: false, authRequired: true, message: "Sign in with an allowed Google account." });
  if (method === "POST") {
    const b = JSON.parse(body || "{}");
    db.posts.push(b);
    const admin = () => b.session === db.validSession;
    switch (b.action) {
      case "googleLogin":
        if (b.idToken === "tok-allowed") return json({ success: true, email: "admin@example.com", session: "sess-1", expiresAt: Date.now() + 864e5 });
        return json({ success: false, email: "stranger@gmail.com", message: "This Google account is not allowed: stranger@gmail.com" });
      case "add": {
        const cfg = db.configs.find(c => c.projectName === b.project);
        if (!db.projects.includes(b.project)) return json({ success: false, message: "Project sheet not found." });
        if (cfg && cfg.isClosed) return json({ success: false, message: "This project is closed. New pins cannot be added." });
        let out = false, dist = null;
        if (cfg && cfg.baseLat !== null && cfg.radiusKms.length) { dist = km(cfg.baseLat, cfg.baseLng, b.data.lat, b.data.lng); out = dist > cfg.radiusKm; }
        db.rows[b.project].push({ EmployeeID: b.data.name, SurveyID: b.data.surveyId, Latitude: b.data.lat, Longitude: b.data.lng, Timestamp: b.data.timestamp || new Date().toISOString(),
          OutOfRadius: out, DistanceKm: dist, RadiusKm: cfg ? cfg.radiusKm : null, RadiusKms: cfg ? cfg.radiusKms : [], ID: db.rows[b.project].length + 2 });
        return json({ success: true, message: "Data added.", outOfRadius: out, distanceKm: dist, radiusKm: cfg ? cfg.radiusKm : null, slackSent: out });
      }
      case "addProject":
        if (!admin()) return refused;
        if (!b.projectName || db.projects.includes(b.projectName)) return json({ success: false, message: "A project with that name already exists." });
        db.projects.push(b.projectName); db.rows[b.projectName] = []; return json({ success: true });
      case "renameProject":
        if (!admin()) return refused;
        db.projects = db.projects.map(p => p === b.oldProjectName ? b.newProjectName : p); db.rows[b.newProjectName] = db.rows[b.oldProjectName] || []; return json({ success: true });
      case "hideProject": case "deleteProject":
        if (!admin()) return refused;
        db.projects = db.projects.filter(p => p !== b.projectName); return json({ success: true });
      case "reorderProjects":
        if (!admin()) return refused;
        db.projects = b.projectOrder.filter(p => db.projects.includes(p)).concat(db.projects.filter(p => !b.projectOrder.includes(p))); return json({ success: true });
      case "updateProjectConfig": {
        if (!admin()) return refused;
        const c = b.config || {}, radiusKms = c.radiusKms || [];
        db.configs = db.configs.filter(x => x.projectName !== b.projectName).concat([{ projectName: b.projectName, baseLat: c.baseLat ?? null, baseLng: c.baseLng ?? null, radiusKms, radiusKm: radiusKms.length ? Math.max(...radiusKms) : null, isClosed: c.isClosed === true }]);
        return json({ success: true, data: db.configs });
      }
      case "updateLabels":
        if (!admin()) return refused;
        db.labels = { employeeId: (b.employeeId || "").trim() || "Employee ID", surveyId: (b.surveyId || "").trim() || "Survey ID" }; return json({ success: true, labels: db.labels });
      case "reportRecord": {
        if (!db.projects.includes(b.project) || !REQUESTS[b.request]) return json({ success: false, message: "Project not found." });
        if (b.request === "other" && !(b.note || "").trim()) return json({ success: false, message: "Please describe what should be changed." });
        const r = b.record || {};
        db.reports.push({ ID: db.reports.length + 2, Timestamp: new Date().toISOString(), Project: b.project, EmployeeID: r.EmployeeID, SurveyID: r.SurveyID, Latitude: r.Latitude, Longitude: r.Longitude, RecordTimestamp: r.Timestamp,
          Request: b.request, RequestText: REQUESTS[b.request], Note: b.note || "", ReportedBy: b.reportedBy || "", status: "open" });
        return json({ success: true, message: "Sent to the admin.", id: db.reports.length + 1, slackSent: false });
      }
      case "getAdmins":
        if (!admin()) return refused;
        return json({ success: true, data: db.admins, me: "admin@example.com" });
      case "addAdmin": {
        if (!admin()) return refused;
        const email = String(b.email || "").trim().toLowerCase();
        if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/.test(email)) return json({ success: false, message: "Enter a valid email address." });
        if (db.admins.some(a => a.email === email)) return json({ success: false, message: email + " is already an admin." });
        db.admins.push({ email, note: "added by admin@example.com", owner: false });
        return json({ success: true, data: db.admins, me: "admin@example.com" });
      }
      case "removeAdmin":
        if (!admin()) return refused;
        db.admins = db.admins.filter(a => a.email !== b.email);
        return json({ success: true, data: db.admins, me: "admin@example.com" });
      case "resolveReport":
        if (!admin()) return refused;
        db.reports = db.reports.map(r => r.ID === b.id ? { ...r, status: "done" } : r); return json({ success: true, data: db.reports.filter(r => r.status === "open") });
      default:
        return json({ success: false, message: "Invalid action specified: " + b.action });
    }
  }
  const u = new URL(url);
  const action = u.searchParams.get("action");
  if (action === "version") return json({ success: true, data: { version: "v12.3" } });
  if (action === "getProjects") return json({ success: true, data: db.projects, configs: db.configs, labels: db.labels });
  if (action === "getProjectConfigs") return json({ success: true, data: db.configs });
  if (action === "getReports") return json({ success: true, data: db.reports.filter(r => (u.searchParams.get("status") || "open") === "all" || r.status === (u.searchParams.get("status") || "open")) });
  if (action === "getData") { const rows = db.rows[u.searchParams.get("project")]; return rows ? json({ success: true, data: rows }) : json({ success: false, message: "Project sheet not found." }); }
  return json({ success: false, message: "Invalid GET action or missing parameters." });
}

// Wires the fake into a page. options.signedIn pre-signs the admin in on this device.
export async function installFakeBackend(page, db, options = {}) {
  await page.route("**/script.google.com/**", route => {
    if (db.offline) return route.abort("internetdisconnected");   // db.offline = true plays "no signal"
    const req = route.request();
    route.fulfill(handle(db, req.method(), req.url(), req.postData()));
  });
  await page.route("**/nominatim.openstreetmap.org/**", route => {
    if (db.geoOffline) return route.abort("internetdisconnected");
    const u = new URL(route.request().url());
    if (!u.pathname.includes("/search")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ display_name: "88 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพมหานคร 10110" }) });
    const q = u.searchParams.get("q");
    const hits = q in GEO.nominatim ? GEO.nominatim[q] : [{ lat: "13.9", lon: "100.6", display_name: "Somewhere, Bangkok" }];
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hits) });
  });
  await page.route("**/photon.komoot.io/**", route => {
    if (db.geoOffline) return route.abort("internetdisconnected");
    if (db.photonHang) return;   // never answers, like a weak phone signal
    const q = new URL(route.request().url()).searchParams.get("q");
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ type: "FeatureCollection", features: GEO.photon[q] || [] }) });
  });
  // Google's sign-in script never loads; a stand-in button calls the page's callback with a fake credential.
  await page.route("**/accounts.google.com/**", route => route.abort());
  await page.addInitScript(({ signedIn }) => {
    window.__errors = [];
    addEventListener("error", e => window.__errors.push(String(e.message)));
    addEventListener("unhandledrejection", e => window.__errors.push("rejection: " + String(e.reason)));
    if (signedIn && !localStorage.getItem("admin_session")) { localStorage.setItem("admin_session", "sess-1"); localStorage.setItem("admin_email", "admin@example.com"); }
    window.__gis = {};
    window.google = { accounts: { id: {
      initialize: cfg => { window.__gis.cfg = cfg; },
      renderButton: el => { el.innerHTML = '<button type="button" id="fake-google-btn" style="height:44px;padding:0 20px;border:1px solid #dadce0;border-radius:22px;background:#fff;color:#1f1f1f;font:500 14px sans-serif">Sign in with Google</button>'; el.querySelector("button").onclick = () => window.__gis.cfg.callback({ credential: window.__gisToken || "tok-allowed" }); },
      disableAutoSelect: () => { window.__gis.disabled = true; },
    } } };
  }, { signedIn: !!options.signedIn });
}
