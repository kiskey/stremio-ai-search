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

// First, let's check if the port is in use and clean up
const net = require('net');
const testServer = net.createServer()
    .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n[${new Date().toISOString()}] 🔴 Port 7000 is already in use! Stopping previous instance...`);
            process.exit(1);
        }
    })
    .once('listening', () => {
        testServer.close();
        startServer();
    })
    .listen(7000);

function startServer() {
    logWithTime('Starting Stremio Addon Server...');
    logWithTime('Manifest:', addonInterface.manifest);
    logWithTime('Using Gemini API Key:', `${process.env.GEMINI_API_KEY.substring(0, 8)}...`);
    
    try {
        // Create HTTP server with request logging middleware
        const app = require('express')();
        app.use((req, res, next) => {
            logWithTime(`Incoming request: ${req.method} ${req.url}`, {
                headers: req.headers,
                query: req.query,
                body: req.body
            });
            next();
        });

        // Add error handling middleware
        app.use((err, req, res, next) => {
            logError('Express error:', err);
            next(err);
        });

        // Start the Stremio addon server
        serveHTTP(addonInterface, { port: 7000, host: '0.0.0.0' });
        logWithTime('Server started successfully! 🚀');
        
        // Add more detailed connection information
        const publicUrl = `http://${process.env.HOST || '0.0.0.0'}:${process.env.PORT || 7000}`;
        logWithTime('Server is accessible at:', publicUrl);
        logWithTime('Add to Stremio using:', `${publicUrl}/manifest.json`);
        
    } catch (error) {
        console.error(`\n[${new Date().toISOString()}] 🔴 Failed to start server:`, error);
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