const fs = require("fs");
const path = require("path");

// Use environment variable for logging
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

// Create logs directory if logging is enabled
const logsDir = path.join(__dirname, "..", "logs");
if (ENABLE_LOGGING && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

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
  ENABLE_LOGGING,
};

module.exports = logger;
