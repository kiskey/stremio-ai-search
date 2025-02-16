require('dotenv').config();
const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

// Add a custom logging function
function logWithTime(message, data = '') {
    const timestamp = new Date().toISOString();
    if (data) {
        console.log(`\n[${timestamp}] 🔵 ${message}`, data);
    } else {
        console.log(`\n[${timestamp}] 🔵 ${message}`);
    }
}

// Update the environment variable check to be more permissive
if (!process.env.GEMINI_API_KEY) {
    console.warn(`\n[${new Date().toISOString()}] ⚠️ WARNING: GEMINI_API_KEY environment variable is not set!`);
    // Don't exit, just warn
}

if (!process.env.TMDB_API_KEY) {
    console.warn(`\n[${new Date().toISOString()}] ⚠️ WARNING: TMDB_API_KEY environment variable is not set!`);
    // Don't exit, just warn
}

// Error handlers
process.on('uncaughtException', (err) => {
    console.error(`\n[${new Date().toISOString()}] 🔴 Uncaught Exception:`, err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n[${new Date().toISOString()}] 🔴 Unhandled Rejection:`, reason);
});

const PORT = process.env.PORT || 7000;

// Function to kill process using a port
function killProcessOnPort(port) {
    return new Promise((resolve, reject) => {
        const command = process.platform === 'win32' 
            ? `netstat -ano | findstr :${port}`
            : `lsof -i :${port} -t`;

        require('child_process').exec(command, (error, stdout, stderr) => {
            if (error || !stdout) {
                resolve(); // No process found, that's fine
                return;
            }

            const pids = stdout.split('\n')
                .map(line => line.trim())
                .filter(Boolean);

            pids.forEach(pid => {
                try {
                    process.kill(pid, 'SIGKILL');
                    logWithTime(`Killed process ${pid} on port ${port}`);
                } catch (e) {
                    // Ignore errors
                }
            });
            
            setTimeout(resolve, 1000); // Give processes time to die
        });
    });
}

// Modify the server startup
async function startServer() {
    try {
        await killProcessOnPort(PORT);
        
        const app = require('express')();

        // Increase JSON size limit for large responses
        app.use(require('express').json({ limit: '10mb' }));
        
        // Add compression for faster responses
        app.use(require('compression')());

        // Enhanced Android TV detection and handling
        app.use((req, res, next) => {
            // Log all incoming requests
            logWithTime('Incoming request:', {
                method: req.method,
                url: req.url,
                headers: req.headers,
                query: req.query
            });

            const isAndroidTV = 
                req.headers['stremio-platform'] === 'android-tv' || 
                req.headers['user-agent']?.toLowerCase().includes('android tv') ||
                req.query.platform === 'android-tv';

            // Add platform info to the request
            req.stremioInfo = {
                platform: isAndroidTV ? 'android-tv' : 'unknown',
                isAndroidTV
            };

            if (isAndroidTV) {
                logWithTime('Android TV Request detected:', {
                    url: req.url,
                    headers: req.headers,
                    query: req.query
                });

                // Modify headers for Android TV
                res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.header('Pragma', 'no-cache');
                res.header('Expires', '0');
            }

            // Ensure proper CORS headers for all requests
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

            next();
        });

        // Add this route before mounting the Stremio addon
        app.get('/catalog/:type/:id/:extra?.json', (req, res, next) => {
            logWithTime('Catalog request received:', {
                params: req.params,
                query: req.query,
                platform: req.stremioInfo?.platform
            });
            next();
        });

        // Error handling middleware
        app.use((err, req, res, next) => {
            logError('Express error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal Server Error' });
            }
            next(err);
        });

        // Mount the Stremio addon using the SDK's router with a prefix
        const { getRouter } = require('stremio-addon-sdk');
        app.use('/', getRouter(addonInterface));

        // Start the server with enhanced settings
        const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
            logWithTime('Server started successfully! 🚀');
            const publicUrl = `http://${process.env.HOST || '0.0.0.0'}:${PORT}`;
            logWithTime('Server is accessible at:', publicUrl);
            logWithTime('Add to Stremio using:', `${publicUrl}/manifest.json`);
        });

        // Enhanced server settings
        server.timeout = 60000; // 60 seconds
        server.keepAliveTimeout = 65000; // 65 seconds
        server.headersTimeout = 66000; // 66 seconds
        
        // Handle server errors
        server.on('error', (error) => {
            logError('Server error:', error);
        });

    } catch (error) {
        logError('Failed to start server:', error);
        process.exit(1);
    }
}

function logError(message, error = '') {
    const timestamp = new Date().toISOString();
    console.error(`\n[${timestamp}] 🔴 ${message}`, error);
    if (error && error.stack) {
        console.error(`Stack trace:`, error.stack);
    }
}

// Remove the testServer code and just call startServer
startServer();