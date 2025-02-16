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
        // First kill any existing processes on our port
        await killProcessOnPort(PORT);

        logWithTime('Starting Stremio Addon Server...');
        logWithTime('Manifest:', addonInterface.manifest);
        
        // Just log whether keys are configured, not their values
        if (process.env.GEMINI_API_KEY) {
            logWithTime('✓ Gemini API Key is configured');
        } else {
            logWithTime('✗ Gemini API Key is missing');
        }
        
        if (process.env.TMDB_API_KEY) {
            logWithTime('✓ TMDB API Key is configured');
        } else {
            logWithTime('✗ TMDB API Key is missing');
        }
        
        // Create HTTP server with request logging middleware
        const app = require('express')();

        // Add Android TV specific middleware
        app.use((req, res, next) => {
            // Increase timeout for Android TV
            if (req.headers['stremio-platform'] === 'android-tv' || 
                req.headers['user-agent']?.toLowerCase().includes('android tv')) {
                req.setTimeout(45000); // 45 seconds for TV
                res.setTimeout(45000);
            }

            // Add TV-specific headers
            res.header('Cache-Control', 'public, max-age=3600'); // 1 hour cache
            res.header('X-Content-Type-Options', 'nosniff');
            res.header('X-Frame-Options', 'SAMEORIGIN');
            
            next();
        });

        // Add CORS headers
        app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            next();
        });

        // Handle OPTIONS requests
        app.options('*', (req, res) => {
            res.status(200).end();
        });

        // Add response time logging
        app.use((req, res, next) => {
            const start = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - start;
                logWithTime(`Request completed: ${req.method} ${req.url}`, {
                    duration: `${duration}ms`,
                    userAgent: req.headers['user-agent'],
                    platform: req.headers['stremio-platform'] || 'unknown'
                });
            });
            next();
        });

        // Mount the Stremio addon
        app.use((req, res, next) => {
            addonInterface.middleware(req, res, next);
        });

        // Start the server
        const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
            logWithTime('Server started successfully! 🚀');
            const publicUrl = `http://${process.env.HOST || '0.0.0.0'}:${PORT}`;
            logWithTime('Server is accessible at:', publicUrl);
            logWithTime('Add to Stremio using:', `${publicUrl}/manifest.json`);
        });

        // Set server timeouts
        server.timeout = 45000; // 45 seconds
        server.keepAliveTimeout = 60000; // 60 seconds
        
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