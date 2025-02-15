module.exports = {
    apps: [{
        name: "stremio-ai-addon",
        script: "./aisearch/server.js",
        cwd: "./aisearch",
        env: {
            NODE_ENV: "production",
            PORT: 7000,
            HOST: "localhost"
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