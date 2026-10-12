// Lint for the single-file app: every inline <script> must parse, the page must declare lang,
// a title, the viewport meta, and the markers the e2e tests rely on.
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../Index.html", import.meta.url), "utf8");
const problems = [];

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) problems.push("no inline <script> found");
scripts.forEach((code, i) => {
  try { new vm.Script(code, { filename: `Index.html#script${i + 1}` }); }
  catch (e) { problems.push(`script ${i + 1} does not parse: ${e.message}`); }
});

for (const [name, re] of Object.entries({
  "html lang": /<html[^>]*\slang="/,
  "title": /<title>[^<]+<\/title>/,
  "viewport meta": /<meta name="viewport"/,
  "WEB_APP_URL": /const WEB_APP_URL = 'https:\/\/script\.google\.com\/macros\/s\/[^']+\/exec';/,
  "GOOGLE_CLIENT_ID": /const GOOGLE_CLIENT_ID = '[^']+\.apps\.googleusercontent\.com';/,
})) if (!re.test(html)) problems.push(`missing ${name}`);

if (/AKfycbyWJlVX/.test(html)) problems.push("page still points at the old V6 backend");
if (/ADMIN_PASSWORD|verifyPassword/.test(html)) problems.push("password login code is back");

const gs = fs.readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
try { new vm.Script(gs, { filename: "Code.gs" }); } catch (e) { problems.push(`Code.gs does not parse: ${e.message}`); }
if (/hooks\.slack\.com|GOCSPX|AKfycb[\w-]{20,}/.test(gs)) problems.push("Code.gs contains a URL or secret that belongs in Script properties");

if (problems.length) { problems.forEach(p => console.error("LINT:", p)); process.exit(1); }
console.log(`lint ok (${scripts.length} inline scripts parsed)`);
