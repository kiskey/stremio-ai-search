const path = require("path");
const currentDir = path.basename(path.resolve(__dirname));
const isDev = currentDir.endsWith("dev");

module.exports = {
  apps: [
    {
      name: isDev ? "stremio-ai-addon-dev" : "stremio-ai-addon",
      script: "./server.js",
      cwd: ".",
      env: {
        NODE_ENV: isDev ? "development" : "production",
        PORT: isDev ? 7001 : 7000,
        HOST: "0.0.0.0",
        ENCRYPTION_KEY:
          "K1EfDDEuHqRapCq6F5YmgWs9PDTS36HInoROwXHR5xJLNsWYKjAZwitcRSQHT2aJNmRLqxBtY39EQdbvVl8HA0VMe8DXClIDNP9dmXivKeaz3JeYD3haZJUaMZUzSMJ2",
      },
      watch: ["server.js", "addon.js"],
      ignore_watch: ["node_modules", "*.log"],
      max_memory_restart: "300M", // Restart if memory exceeds 300MB
      instances: 1, // Changed to 1 instance to avoid port conflicts
      exec_mode: "fork", // Changed to fork mode
      log_date_format: "YYYY-MM-DD HH:mm:ss [Australia/Melbourne]",
      error_file: isDev ? "./logs/dev-error.log" : "/dev/null",
      out_file: isDev ? "./logs/dev-out.log" : "/dev/null",
      merge_logs: true,
      autorestart: true, // Auto restart if app crashes
      restart_delay: 4000, // Delay between automatic restarts
      max_restarts: 10, // Number of times to restart before stopping
      exp_backoff_restart_delay: 100, // Delay between restarts
      min_uptime: "30s",
      listen_timeout: 8000,
      kill_timeout: 5000,
    },
  ],
};
