/**
 * Location Tracker V12 — Apps Script backend (own Google Sheet, separate from the V6 Sheet).
 *
 * Setup (once, in the Apps Script editor bound to the new Sheet):
 *   Project Settings (gear) → Script properties → add
 *     ADMIN_PASSWORD     = password for the admin lock in the app
 *     SLACK_WEBHOOK_URL  = (optional) Slack incoming webhook; leave empty to turn alerts off
 *     SPREADSHEET_ID     = (optional) only if this script is NOT bound to the Sheet
 *   Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *
 * No passwords or webhook URLs live in this file on purpose.
 * API is the same as the V6 backend (LT 2.4.2026.15.19) so existing front ends keep working.
 */
const BACKEND_VERSION = "v12.0";
const PROJECT_CONFIG_SHEET_NAME = "ProjectConfigs";
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
        .filter(sheet => sheet.getName() !== PROJECT_CONFIG_SHEET_NAME)
        .map(sheet => sheet.getName());
      return createJsonResponse({ success: true, data: projectNames });
    }

    if (action === "getProjectConfigs") {
      return createJsonResponse({ success: true, data: getProjectConfigs_() });
    }

    if (action === "getData" && project) {
      const sheet = ss.getSheetByName(project);
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

    switch (action) {
      case "notifySlackAnomaly": {
        const sent = sendSlackMessage(request.message || "เจอความผิดปกติในการปักหมุดพิกัด");
        return createJsonResponse({ success: true, sent: sent });
      }

      case "verifyPassword": {
        const providedPassword = request.password;
        const storedPassword = PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD");
        return createJsonResponse({ success: !!(storedPassword && providedPassword && providedPassword === storedPassword) });
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
        if (newName === PROJECT_CONFIG_SHEET_NAME) { throw new Error("That name is reserved."); }
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
        if (projectName === PROJECT_CONFIG_SHEET_NAME) throw new Error("That sheet cannot be hidden.");
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
          const sheet = ss.getSheetByName(projectName);
          if (sheet) {
            ss.setActiveSheet(sheet);
            ss.moveActiveSheet(index + 1);
          }
        });
        return createJsonResponse({ success: true, message: "Projects reordered successfully." });
      }

      case "add": {
        const sheet = getProjectSheet_(ss, request.project);
        ensureProjectDataHeaders_(sheet);
        const data = request.data || {};
        const savedTimestamp = parseClientTimestamp_(data.timestamp || data.Timestamp || data.savedAt) || new Date();
        sheet.appendRow(buildDataRow_(data, savedTimestamp));
        return createJsonResponse({ success: true, message: "Data added." });
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
  if (project === PROJECT_CONFIG_SHEET_NAME) { throw new Error("Invalid project."); }
  const sheet = ss.getSheetByName(project);
  if (!sheet) { throw new Error("Project sheet '" + project + "' not found."); }
  return sheet;
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

  const unique = Array.from(new Set(radii.map(function(v) {
    return Number(v.toFixed(3));
  }))).sort(function(a, b) { return a - b; });

  return unique.length ? unique : [5];
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
        radiusKm: Math.max.apply(null, radiusKms),
        isClosed: row[4] === true || String(row[4]).toLowerCase() === "true"
      };
    });
}

function updateProjectConfig_(projectName, config) {
  if (!projectName) throw new Error("Project name is required.");

  const sheet = getProjectConfigSheet_();
  const values = sheet.getDataRange().getValues();
  const targetName = String(projectName).trim();
  const radiusKms = parseRadiusKms_(config.radiusKms || config.radiusKm);
  const blank = v => v === null || v === "" || v === undefined;

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

// Returns true when the message went to Slack; false when no webhook is set (alerts off).
function sendSlackMessage(message) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_URL");
  if (!webhookUrl) {
    Logger.log("Slack alert skipped (SLACK_WEBHOOK_URL not set): " + message);
    return false;
  }

  UrlFetchApp.fetch(webhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ text: message }),
    muteHttpExceptions: true
  });
  return true;
}
