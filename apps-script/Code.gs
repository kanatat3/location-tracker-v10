/**
 * Location Tracker V12 — Apps Script backend (own Google Sheet, separate from the V6 Sheet).
 *
 * Setup (once, in the Apps Script editor bound to the new Sheet):
 *   Project Settings (gear) → Script properties → add
 *     GOOGLE_CLIENT_ID   = OAuth client ID (Web) the page uses for "Sign in with Google"
 *     SLACK_WEBHOOK_URL  = (optional) Slack incoming webhook for "pin outside the radius" alerts
 *     SLACK_ALERT_URL + SLACK_ALERT_SECRET = (optional) the Slack relay web app and its secret, used when
 *                          SLACK_WEBHOOK_URL is empty. With none of them set, alerts are off.
 *     SPREADSHEET_ID     = (optional) only if this script is NOT bound to the Sheet
 *   Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *
 *
 * Admin access = Google sign-in. Who may enter is the list in the "AllowedEmails" tab of the Sheet
 * (one email per row, column A). The tab is created on first use with the script owner's email in it.
 * Adding or removing a row takes effect at once; no new deployment is needed.
 *
 * Project settings (ProjectConfigs tab, edited from the admin screen): main coordinate, one or more radius
 * circles (the widest one is the limit) and a Closed switch. When a pin arrives the server itself measures
 * the distance to the main coordinate, marks the row OutOfRadius and sends the Slack alert; a closed project
 * accepts no new pins.
 *
 * No passwords or webhook URLs live in this file on purpose.
 * API is the same as the V6 backend (LT 2.4.2026.15.19) so existing front ends keep working.
 */
const BACKEND_VERSION = "v12.2";
const PROJECT_CONFIG_SHEET_NAME = "ProjectConfigs";
const ALLOWED_EMAILS_SHEET_NAME = "AllowedEmails";
const RESERVED_SHEET_NAMES = [PROJECT_CONFIG_SHEET_NAME, ALLOWED_EMAILS_SHEET_NAME];
// Actions that change projects or saved rows: only for a signed-in, allowed Google account.
const ADMIN_ACTIONS = ["updateProjectConfig", "addProject", "renameProject", "deleteProject", "hideProject", "reorderProjects", "update", "delete"];
const SESSION_DAYS = 30;
const DATA_HEADERS = [
  "EmployeeID",
  "SurveyID",
  "Timestamp",
  "Latitude",
  "Longitude",
  "GoogleMapsLink",
  "OutOfRadius",
  "DistanceKm",
  "RadiusKm",
  "RadiusKms",
  "SlackAlertRequired",
  "SlackMessage"
];

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("No spreadsheet: bind this script to a Sheet or set SPREADSHEET_ID.");
  return ss;
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    const project = e.parameter.project;

    if (action === "version") {
      return createJsonResponse({ success: true, data: { version: BACKEND_VERSION } });
    }

    const ss = getSpreadsheet_();

    if (action === "getProjects") {
      const projectNames = ss.getSheets()
        .filter(sheet => !sheet.isSheetHidden())
        .filter(sheet => !isReservedSheetName_(sheet.getName()))
        .map(sheet => sheet.getName());
      return createJsonResponse({ success: true, data: projectNames, configs: getProjectConfigs_() });
    }

    if (action === "getProjectConfigs") {
      return createJsonResponse({ success: true, data: getProjectConfigs_() });
    }

    if (action === "getData" && project) {
      const sheet = isReservedSheetName_(project) ? null : ss.getSheetByName(project);
      if (!sheet) { throw new Error("Project sheet not found."); }

      const dataRange = sheet.getDataRange();
      if (dataRange.getNumRows() <= 1) {
        return createJsonResponse({ success: true, data: [] });
      }

      const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const values = dataRange.offset(1, 0, dataRange.getNumRows() - 1, dataRange.getNumColumns()).getValues();
      const col = name => sheetHeaders.indexOf(name);

      const employeeIdColIndex = col("EmployeeID");
      const surveyIdColIndex = col("SurveyID");
      const timestampColIndex = col("Timestamp");
      const latitudeColIndex = col("Latitude");
      const longitudeColIndex = col("Longitude");
      const googleMapsLinkColIndex = col("GoogleMapsLink");
      const outOfRadiusColIndex = col("OutOfRadius");
      const distanceKmColIndex = col("DistanceKm");
      const radiusKmColIndex = col("RadiusKm");
      const radiusKmsColIndex = col("RadiusKms");
      const slackAlertRequiredColIndex = col("SlackAlertRequired");
      const slackMessageColIndex = col("SlackMessage");

      const result = values.map((row, index) => {
        const rowObject = {};

        rowObject.EmployeeID = employeeIdColIndex !== -1 ? String(row[employeeIdColIndex] || "").replace(/^'/, "") : null;
        rowObject.SurveyID = surveyIdColIndex !== -1 ? String(row[surveyIdColIndex] || "").replace(/^'/, "") : null;
        rowObject.GoogleMapsLink = googleMapsLinkColIndex !== -1 ? row[googleMapsLinkColIndex] : null;
        rowObject.Latitude = latitudeColIndex !== -1 ? Number(row[latitudeColIndex]) : null;
        rowObject.Longitude = longitudeColIndex !== -1 ? Number(row[longitudeColIndex]) : null;
        rowObject.Timestamp = timestampColIndex !== -1 ? formatTimestampForClient_(row[timestampColIndex]) : "";

        if (outOfRadiusColIndex !== -1) {
          rowObject.OutOfRadius = row[outOfRadiusColIndex] === true || String(row[outOfRadiusColIndex]).toLowerCase() === "true";
        }
        if (distanceKmColIndex !== -1) rowObject.DistanceKm = Number(row[distanceKmColIndex]);
        if (radiusKmColIndex !== -1) rowObject.RadiusKm = Number(row[radiusKmColIndex]);
        if (radiusKmsColIndex !== -1) rowObject.RadiusKms = parseRadiusKms_(row[radiusKmsColIndex]);
        if (slackAlertRequiredColIndex !== -1) {
          rowObject.SlackAlertRequired = row[slackAlertRequiredColIndex] === true || String(row[slackAlertRequiredColIndex]).toLowerCase() === "true";
        }
        if (slackMessageColIndex !== -1) rowObject.SlackMessage = row[slackMessageColIndex] || "";

        rowObject.ID = index + 2;
        return rowObject;
      });

      return createJsonResponse({ success: true, data: result });
    }

    throw new Error("Invalid GET action or missing parameters.");
  } catch (error) {
    Logger.log("Error in doGet: " + error.toString());
    return createJsonResponse({ success: false, message: error.message });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const request = JSON.parse(e.postData.contents);
    const action = request.action;
    const ss = getSpreadsheet_();

    if (ADMIN_ACTIONS.indexOf(action) !== -1 && !getSessionEmail_(request.session)) {
      return createJsonResponse({ success: false, authRequired: true, message: "Sign in with an allowed Google account." });
    }

    switch (action) {
      // Retired: the alert is now sent by "add" itself, so nobody can post free text to Slack through this app.
      case "notifySlackAnomaly": {
        return createJsonResponse({ success: true, sent: false });
      }

      // The admin password is gone; old pages that still ask for it are always refused.
      case "verifyPassword": {
        return createJsonResponse({ success: false, message: "Password login was replaced by Google sign-in." });
      }

      case "googleLogin": {
        const email = verifyGoogleIdToken_(request.idToken);
        if (!isEmailAllowed_(email)) {
          return createJsonResponse({ success: false, email: email, message: "This Google account is not allowed: " + email });
        }
        const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
        return createJsonResponse({ success: true, email: email, session: signSession_(email, expiresAt), expiresAt: expiresAt });
      }

      case "getProjectConfigs": {
        return createJsonResponse({ success: true, data: getProjectConfigs_() });
      }

      case "updateProjectConfig": {
        updateProjectConfig_(request.projectName, request.config || {});
        return createJsonResponse({ success: true, data: getProjectConfigs_() });
      }

      case "addProject": {
        const name = String(request.projectName || "").trim();
        if (!name) { throw new Error("Project name is required."); }
        if (isReservedSheetName_(name)) { throw new Error("That name is reserved."); }
        if (ss.getSheetByName(name)) { throw new Error(`A project with the name '${name}' already exists.`); }
        const newSheet = ss.insertSheet(name);
        newSheet.appendRow(DATA_HEADERS);
        formatDataColumns_(newSheet);
        return createJsonResponse({ success: true, message: "Project created successfully." });
      }

      case "renameProject": {
        const oldName = String(request.oldProjectName || "").trim();
        const newName = String(request.newProjectName || "").trim();
        if (!oldName || !newName) { throw new Error("Old and new project names are required."); }
        if (isReservedSheetName_(newName) || isReservedSheetName_(oldName)) { throw new Error("That name is reserved."); }
        if (ss.getSheetByName(newName)) { throw new Error(`A project with the name '${newName}' already exists.`); }
        const sheetToRename = ss.getSheetByName(oldName);
        if (!sheetToRename) { throw new Error(`Project '${oldName}' not found.`); }
        sheetToRename.setName(newName);
        renameProjectConfig_(oldName, newName);
        return createJsonResponse({ success: true, message: "Project renamed successfully." });
      }

      // "Delete" keeps the data: the tab is only hidden (same as the V6 backend).
      case "deleteProject":
      case "hideProject": {
        const projectName = request.projectName;
        if (!projectName) throw new Error("Project name is required.");
        if (isReservedSheetName_(projectName)) throw new Error("That sheet cannot be hidden.");
        const sheet = ss.getSheetByName(projectName);
        if (sheet) sheet.hideSheet();
        return createJsonResponse({ success: true, message: `Project '${projectName}' has been hidden.` });
      }

      case "reorderProjects": {
        const projectOrder = request.projectOrder;
        if (!projectOrder || !Array.isArray(projectOrder)) {
          throw new Error("A valid project order array is required.");
        }
        projectOrder.forEach((projectName, index) => {
          const sheet = isReservedSheetName_(projectName) ? null : ss.getSheetByName(projectName);
          if (sheet) {
            ss.setActiveSheet(sheet);
            ss.moveActiveSheet(index + 1);
          }
        });
        return createJsonResponse({ success: true, message: "Projects reordered successfully." });
      }

      case "add": {
        const sheet = getProjectSheet_(ss, request.project);
        const config = getProjectConfig_(request.project);
        if (config && config.isClosed) { throw new Error("This project is closed. New pins cannot be added."); }
        const data = request.data || {};
        const lat = Number(data.lat), lng = Number(data.lng);
        if (data.lat === "" || data.lat === null || data.lng === "" || data.lng === null
            || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          throw new Error("A valid coordinate is required.");
        }
        ensureProjectDataHeaders_(sheet);
        const savedTimestamp = parseClientTimestamp_(data.timestamp || data.Timestamp || data.savedAt) || new Date();

        // The server decides whether the pin is outside the radius; what the page says is not trusted.
        const alert = getRadiusAlert_(config, lat, lng);
        if (alert) {
          data.outOfRadius = alert.outOfRadius;
          data.distanceKm = alert.distanceKm;
          data.radiusKm = alert.radiusKm;
          data.radiusKms = alert.radiusKms;
          data.slackAlertRequired = alert.outOfRadius;
          data.slackMessage = alert.outOfRadius ? buildSlackAnomalyMessage_(request.project, data, lat, lng, alert) : "";
        }
        sheet.appendRow(buildDataRow_(data, savedTimestamp));

        let slackSent = false;
        if (alert && alert.outOfRadius) {
          try {
            slackSent = sendSlackAlert_(data.slackMessage, request.project, data);
          } catch (slackError) {
            Logger.log("Slack alert failed: " + slackError);
          }
        }
        return createJsonResponse({
          success: true, message: "Data added.",
          outOfRadius: !!(alert && alert.outOfRadius),
          distanceKm: alert ? alert.distanceKm : null,
          radiusKm: alert ? alert.radiusKm : null,
          slackSent: slackSent
        });
      }

      case "update": {
        const sheet = getProjectSheet_(ss, request.project);
        ensureProjectDataHeaders_(sheet);
        const rowId = Number(request.id);
        if (!Number.isInteger(rowId) || rowId < 2 || rowId > sheet.getLastRow()) throw new Error("Invalid row ID.");
        const data = request.data || {};
        const updateTimestamp = parseClientTimestamp_(data.timestamp || data.Timestamp || data.savedAt) || new Date();
        sheet.getRange(rowId, 1, 1, DATA_HEADERS.length).setValues([buildDataRow_(data, updateTimestamp)]);
        return createJsonResponse({ success: true, message: "Data updated." });
      }

      case "delete": {
        const sheet = getProjectSheet_(ss, request.project);
        const rowId = Number(request.id);
        if (!Number.isInteger(rowId) || rowId < 2 || rowId > sheet.getLastRow()) throw new Error("Invalid row ID.");
        sheet.deleteRow(rowId);
        return createJsonResponse({ success: true, message: "Row deleted." });
      }

      default:
        throw new Error("Invalid action specified: " + action);
    }
  } catch (error) {
    Logger.log("Error in doPost: " + error.toString());
    return createJsonResponse({ success: false, message: error.message });
  } finally {
    lock.releaseLock();
  }
}

function getProjectSheet_(ss, project) {
  if (!project) { throw new Error("Project name is required for this action."); }
  if (isReservedSheetName_(project)) { throw new Error("Invalid project."); }
  const sheet = ss.getSheetByName(project);
  if (!sheet) { throw new Error("Project sheet '" + project + "' not found."); }
  return sheet;
}

function isReservedSheetName_(name) {
  return RESERVED_SHEET_NAMES.indexOf(String(name).trim()) !== -1;
}

// ---- Google sign-in for admins ----

function getAllowedEmailsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(ALLOWED_EMAILS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ALLOWED_EMAILS_SHEET_NAME);
    sheet.appendRow(["Email", "Note"]);
    const owner = String(Session.getEffectiveUser().getEmail() || "").trim().toLowerCase();
    if (owner) sheet.appendRow([owner, "owner (added automatically)"]);
  }
  return sheet;
}

function isEmailAllowed_(email) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) return false;
  const values = getAllowedEmailsSheet_().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || "").trim().toLowerCase() === target) return true;
  }
  return false;
}

// Asks Google whether the ID token from the page is genuine and was issued for this app.
function verifyGoogleIdToken_(idToken) {
  const clientId = PropertiesService.getScriptProperties().getProperty("GOOGLE_CLIENT_ID");
  if (!clientId) throw new Error("Google sign-in is not set up yet (GOOGLE_CLIENT_ID).");
  if (!idToken || typeof idToken !== "string") throw new Error("Google sign-in is required.");

  const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error("Google sign-in could not be verified.");

  const info = JSON.parse(response.getContentText());
  const issuerOk = info.iss === "accounts.google.com" || info.iss === "https://accounts.google.com";
  const fresh = Number(info.exp) * 1000 > Date.now();
  if (info.aud !== clientId || !issuerOk || !fresh || String(info.email_verified) !== "true" || !info.email) {
    throw new Error("Google sign-in could not be verified.");
  }
  return String(info.email).trim().toLowerCase();
}

function getSessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty("SESSION_SECRET");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("SESSION_SECRET", secret);
  }
  return secret;
}

function sessionSignature_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, getSessionSecret_()));
}

function signSession_(email, expiresAt) {
  const payload = email + "|" + expiresAt;
  return Utilities.base64EncodeWebSafe(payload) + "." + sessionSignature_(payload);
}

// Returns the email behind a session token, or null when it is forged, expired,
// or the email has since been removed from the AllowedEmails tab.
function getSessionEmail_(session) {
  if (!session || typeof session !== "string") return null;
  const parts = session.split(".");
  if (parts.length !== 2) return null;
  let payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (error) {
    return null;
  }
  if (sessionSignature_(payload) !== parts[1]) return null;
  const cut = payload.lastIndexOf("|");
  const email = payload.slice(0, cut);
  const expiresAt = Number(payload.slice(cut + 1));
  if (cut < 1 || !(expiresAt > Date.now())) return null;
  return isEmailAllowed_(email) ? email : null;
}

function buildDataRow_(data, timestamp) {
  const googleMapsLink = `https://www.google.com/maps?q=${data.lat},${data.lng}`;
  return [
    `'${data.name || ""}`,
    `'${data.surveyId || ""}`,
    timestamp,
    data.lat,
    data.lng,
    googleMapsLink,
    data.outOfRadius === true,
    data.distanceKm || "",
    data.radiusKm || "",
    Array.isArray(data.radiusKms) ? data.radiusKms.join(",") : (data.radiusKms || ""),
    data.slackAlertRequired === true,
    data.slackMessage || ""
  ];
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatTimestampForClient_(value) {
  if (!value) return "";
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return value.toISOString();
  }
  const parsed = parseClientTimestamp_(value);
  return parsed ? parsed.toISOString() : String(value);
}

function parseClientTimestamp_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return isNaN(value.getTime()) ? null : value;
  }

  const direct = new Date(value);
  if (!isNaN(direct.getTime())) return direct;

  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]),
      Number(match[4]), Number(match[5]), Number(match[6] || 0));
    return isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function formatDataColumns_(sheet) {
  sheet.getRange("A2:A").setNumberFormat("@");
  sheet.getRange("B2:B").setNumberFormat("@");
  sheet.getRange("C2:C").setNumberFormat("dd/MM/yyyy, HH:mm:ss");
}

function ensureProjectDataHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  DATA_HEADERS.forEach((header) => {
    if (currentHeaders.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      currentHeaders.push(header);
    }
  });
  formatDataColumns_(sheet);
}

function getProjectConfigSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(PROJECT_CONFIG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PROJECT_CONFIG_SHEET_NAME);
    sheet.appendRow(["ProjectName", "BaseLat", "BaseLng", "RadiusKms", "IsClosed", "UpdatedAt"]);
  }
  return sheet;
}

function parseRadiusKms_(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "").split(/[,|/\s]+/);

  const radii = rawValues
    .map(function(v) { return Number(v); })
    .filter(function(v) { return Number.isFinite(v) && v > 0; });

  // An empty list means "no radius limit".
  return Array.from(new Set(radii.map(function(v) {
    return Number(v.toFixed(3));
  }))).sort(function(a, b) { return a - b; });
}

function getProjectConfigs_() {
  const sheet = getProjectConfigSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  return values.slice(1)
    .filter(function(row) { return row[0]; })
    .map(function(row) {
      const radiusKms = parseRadiusKms_(row[3]);
      return {
        projectName: String(row[0]),
        baseLat: row[1] === "" ? null : Number(row[1]),
        baseLng: row[2] === "" ? null : Number(row[2]),
        radiusKms: radiusKms,
        radiusKm: radiusKms.length ? Math.max.apply(null, radiusKms) : null,
        isClosed: row[4] === true || String(row[4]).toLowerCase() === "true"
      };
    });
}

function getProjectConfig_(projectName) {
  const target = String(projectName || "").trim();
  const found = getProjectConfigs_().filter(function(config) { return config.projectName.trim() === target; });
  return found.length ? found[0] : null;
}

function distanceKm_(lat1, lng1, lat2, lng2) {
  const toRad = function(value) { return value * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLng / 2), 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// null when the project has no main coordinate or no radius; otherwise the distance and whether the pin
// lies beyond the widest circle.
function getRadiusAlert_(config, lat, lng) {
  if (!config || config.baseLat === null || config.baseLng === null || !Number.isFinite(config.baseLat) || !Number.isFinite(config.baseLng) || !config.radiusKms.length) return null;
  const distanceKm = distanceKm_(config.baseLat, config.baseLng, lat, lng);
  return {
    distanceKm: Number(distanceKm.toFixed(3)),
    radiusKm: config.radiusKm,
    radiusKms: config.radiusKms,
    outOfRadius: distanceKm > config.radiusKm
  };
}

function buildSlackAnomalyMessage_(projectName, data, lat, lng, alert) {
  return [
    "*เจอความผิดปกติในการปักหมุดพิกัด*",
    "Project: " + (projectName || "-"),
    "Employee ID: " + (data.name || "-"),
    "Survey ID: " + (data.surveyId || "-"),
    "Coordinate: " + lat.toFixed(6) + ", " + lng.toFixed(6),
    "Distance: " + alert.distanceKm.toFixed(2) + " km",
    "Max Radius: " + Number(alert.radiusKm).toFixed(2) + " km",
    "Map: https://www.google.com/maps?q=" + lat + "," + lng
  ].join("\n");
}

function updateProjectConfig_(projectName, config) {
  if (!projectName) throw new Error("Project name is required.");

  const sheet = getProjectConfigSheet_();
  const values = sheet.getDataRange().getValues();
  const targetName = String(projectName).trim();
  const radiusKms = parseRadiusKms_(config.radiusKms || config.radiusKm);
  const blank = v => v === null || v === "" || v === undefined;
  if (isReservedSheetName_(targetName) || !getSpreadsheet_().getSheetByName(targetName)) throw new Error("Project '" + targetName + "' not found.");
  if (blank(config.baseLat) !== blank(config.baseLng)) throw new Error("Enter both latitude and longitude, or leave both empty.");
  if (!blank(config.baseLat)) {
    const lat = Number(config.baseLat), lng = Number(config.baseLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Invalid coordinate.");
  }

  const rowValues = [
    targetName,
    blank(config.baseLat) ? "" : Number(config.baseLat),
    blank(config.baseLng) ? "" : Number(config.baseLng),
    radiusKms.join(","),
    config.isClosed === true,
    new Date()
  ];

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === targetName) {
      sheet.getRange(i + 1, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }

  sheet.appendRow(rowValues);
}

function renameProjectConfig_(oldProjectName, newProjectName) {
  const sheet = getProjectConfigSheet_();
  const values = sheet.getDataRange().getValues();
  const oldName = String(oldProjectName).trim();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === oldName) {
      sheet.getRange(i + 1, 1).setValue(String(newProjectName).trim());
      sheet.getRange(i + 1, 6).setValue(new Date());
      return;
    }
  }
}

// Sends the "pin outside the radius" alert. Returns true when Slack (or the relay) accepted it,
// false when no destination is set (alerts off) or it answered with an error.
function sendSlackAlert_(message, projectName, data) {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty("SLACK_WEBHOOK_URL");
  const relayUrl = props.getProperty("SLACK_ALERT_URL");
  let response;

  if (webhookUrl) {
    response = UrlFetchApp.fetch(webhookUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ text: message }),
      muteHttpExceptions: true
    });
  } else if (relayUrl) {
    response = UrlFetchApp.fetch(relayUrl, {
      method: "post",
      contentType: "text/plain;charset=utf-8",
      payload: JSON.stringify({
        action: "notifySlackAnomaly", project: projectName, message: message, data: data,
        secret: props.getProperty("SLACK_ALERT_SECRET") || ""
      }),
      muteHttpExceptions: true
    });
  } else {
    Logger.log("Slack alert skipped (no SLACK_WEBHOOK_URL / SLACK_ALERT_URL): " + message);
    return false;
  }
  const code = response.getResponseCode();
  return code >= 200 && code < 400;
}
