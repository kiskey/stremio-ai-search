const fs = require("fs");
const path = require("path");
const isDev = path.basename(path.resolve(__dirname, "..")).endsWith("dev");

// Only create logs directory and enable logging in dev environment
const logsDir = path.join(__dirname, "..", "logs");
if (isDev && !fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function formatMessage(level, message, data) {
  const timestamp = new Date().toISOString();
  const formattedData = data ? `\n${JSON.stringify(data, null, 2)}` : "";
  return `[${timestamp}] ${level}: ${message}${formattedData}\n`;
}

function log(level, message, data) {
  if (!isDev) return; // Only log in dev environment

  const logMessage = formatMessage(level, message, data);

  // Write to console in dev
  console.log(logMessage);

  // Write to file in dev
  fs.appendFile(
    path.join(logsDir, "dev-app.log"),
    logMessage,
    (err) => err && console.error("Error writing to log file:", err)
  );
}

module.exports = {
  info: (message, data) => log("INFO", message, data),
  error: (message, data) => log("ERROR", message, data),
  debug: (message, data) => log("DEBUG", message, data),
  api: (message, data) => log("API", message, data),
  isDev,
};
