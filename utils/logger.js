const fs = require("fs");
const path = require("path");

// Use environment variable for logging
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

// Create logs directory if logging is enabled
const logsDir = path.join(__dirname, "..", "logs");
if (ENABLE_LOGGING && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function formatMessage(level, message, data) {
  const timestamp = new Date().toISOString();
  const formattedData = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  return `[${timestamp}] ${level}: ${message}${formattedData}\n`;
}

function log(level, message, data) {
  if (!ENABLE_LOGGING) return; // Only log if enabled

  const logMessage = formatMessage(level, message, data);

  // Write to console
  console.log(logMessage);

  // Write to file
  fs.appendFile(
    path.join(logsDir, "app.log"),
    logMessage,
    (err) => err && console.error("Error writing to log file:", err)
  );
}

module.exports = {
  info: (message, data) => log("INFO", message, data),
  error: (message, data) => log("ERROR", message, data),
  debug: (message, data) => log("DEBUG", message, data),
  api: (message, data) => log("API", message, data),
  ENABLE_LOGGING,
};
