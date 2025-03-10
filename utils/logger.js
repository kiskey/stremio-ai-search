const fs = require("fs");
const path = require("path");

// Use environment variable for logging
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

// Create logs directory if it doesn't exist (always create it for query logging)
const logsDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Keep track of last query and timestamp to prevent duplicates
let lastQuery = "";
let lastQueryTime = 0;
const DUPLICATE_WINDOW = 15000; // 15 second window to detect duplicates

/**
 * Helper function to format and write logs
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {object} data - Optional data to log
 */
function writeLog(level, message, data) {
  // Format the log message
  const timestamp = new Date().toISOString();
  const formattedData = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  const logMessage = `[${timestamp}] ${level}: ${message}${formattedData}\n`;

  // Write to file
  fs.appendFile(
    path.join(logsDir, "app.log"),
    logMessage,
    () => {} // Silent error handling
  );
}

/**
 * Helper function to get Melbourne time with DST correction
 * @returns {string} Formatted timestamp
 */
function getMelbourneTime() {
  return new Date()
    .toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(/[/]/g, "-")
    .replace(",", "");
}

/**
 * Helper function to log queries independently of ENABLE_LOGGING
 * @param {string} query - The search query
 */
function logQuery(query) {
  const now = Date.now();

  // Check if this is a duplicate query within the time window
  if (query === lastQuery && now - lastQueryTime < DUPLICATE_WINDOW) {
    return; // Skip duplicate query
  }

  // Update last query tracking
  lastQuery = query;
  lastQueryTime = now;

  // Create log line with Melbourne time
  const logLine = `${getMelbourneTime()}|${query}\n`;

  // Write to query log file
  fs.appendFile(
    path.join(logsDir, "query.log"),
    logLine,
    () => {} // Silent error handling
  );
}

/**
 * Helper function to log empty catalog queries to error.log
 * @param {string} query - The search query that returned no results
 * @param {object} data - Additional data about the query (type, filters, etc.)
 */
function logEmptyCatalog(query, data = {}) {
  const timestamp = new Date().toISOString();
  const formattedData = JSON.stringify(data, null, 2);
  const logMessage = `[${timestamp}] EMPTY_CATALOG: Query "${query}" returned no results\n${formattedData}\n`;

  // Write to error log file
  fs.appendFile(
    path.join(logsDir, "error.log"),
    logMessage,
    () => {} // Silent error handling
  );
}

// Simplified logger without console logs, only file logging
const logger = {
  debug: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("DEBUG", message, data);
    }
  },
  info: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("INFO", message, data);
    }
  },
  warn: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("WARN", message, data);
    }
  },
  error: function (message, data) {
    if (ENABLE_LOGGING) {
      writeLog("ERROR", message, data);
    }
  },
  query: logQuery, // Add the query logger to the logger object
  emptyCatalog: function (reason, data = {}) {
    // Skip logging for specific errors we want to ignore
    if (
      reason.includes("Invalid IV length") ||
      reason.includes("punycode") ||
      reason.includes("DeprecationWarning") ||
      // Skip configuration and API key related errors
      reason.includes("Missing configuration") ||
      reason.includes("Invalid configuration") ||
      reason.includes("Missing API keys") ||
      reason.includes("Invalid API key") ||
      (data.error &&
        (data.error.includes("Invalid IV length") ||
          data.error.includes("punycode") ||
          data.error.includes("DeprecationWarning") ||
          data.error.includes("configuration") ||
          data.error.includes("API key")))
    ) {
      return;
    }

    // Always log empty catalogs regardless of ENABLE_LOGGING
    const timestamp = new Date().toISOString();
    const formattedData = JSON.stringify(data, null, 2);
    const logMessage = `[${timestamp}] EMPTY_CATALOG: ${reason}\n${formattedData}\n`;

    // Write to error log file
    fs.appendFile(
      path.join(logsDir, "error.log"),
      logMessage,
      () => {} // Silent error handling
    );
  },
  ENABLE_LOGGING,
};

module.exports = logger;
