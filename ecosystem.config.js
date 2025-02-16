module.exports = {
    apps: [{
        name: "stremio-ai-addon",
        script: "./server.js",
        cwd: ".",
        env: {
            NODE_ENV: "production",
            PORT: 7000,
            HOST: "0.0.0.0"
        },
        watch: [
            "server.js",
            "addon.js"
        ],
        ignore_watch: [
            "node_modules",
            "*.log"
        ],
        log_date_format: "YYYY-MM-DD HH:mm:ss Z"
    }]
}; 