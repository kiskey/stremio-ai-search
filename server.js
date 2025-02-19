require('dotenv').config();
const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const express = require('express');
const compression = require('compression');
const fs = require('fs');

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

// Add this near the top of startServer function
const BASE_PATH = '/aisearch';  // Match your subdomain path

// Modify the server startup
async function startServer() {
    try {
        const app = express();

        // Increase JSON size limit for large responses
        app.use(require('express').json({ limit: '10mb' }));
        
        // Add compression for faster responses
        app.use(compression({
            level: 6,
            threshold: 1024
        }));

        // Log all incoming requests at the very start
        app.use((req, res, next) => {
            logWithTime('Raw incoming request:', {
                method: req.method,
                originalUrl: req.originalUrl,
                path: req.path,
                headers: req.headers,
                baseUrl: req.baseUrl
            });
            next();
        });

        // Android TV detection middleware
        app.use((req, res, next) => {
            const userAgent = req.headers['user-agent'] || '';
            const platform = req.headers['stremio-platform'] || '';
            
            let detectedPlatform = 'unknown';
            
            // Check for Android TV
            if (platform.toLowerCase() === 'android-tv' || 
                userAgent.toLowerCase().includes('android tv') ||
                userAgent.toLowerCase().includes('chromecast') ||
                userAgent.toLowerCase().includes('androidtv')) {
                detectedPlatform = 'android-tv';
            }
            // Check for mobile
            else if (userAgent.toLowerCase().includes('android') || 
                     userAgent.toLowerCase().includes('mobile') || 
                     userAgent.toLowerCase().includes('phone')) {
                detectedPlatform = 'mobile';
            }
            // Check for desktop
            else if (userAgent.toLowerCase().includes('windows') || 
                     userAgent.toLowerCase().includes('macintosh') || 
                     userAgent.toLowerCase().includes('linux')) {
                detectedPlatform = 'desktop';
            }

            // Add all relevant headers to the request
            req.stremioInfo = {
                platform: detectedPlatform,
                userAgent: userAgent,
                originalPlatform: platform
            };

            // Make sure these headers are passed to the addon
            req.headers['stremio-platform'] = detectedPlatform;
            req.headers['stremio-user-agent'] = userAgent;

            logWithTime('Platform Detection:', {
                detectedPlatform,
                userAgent,
                originalPlatform: platform,
                path: req.path
            });
            
            // Set headers
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Cache-Control', 'no-cache');
            
            next();
        });

        // Create a router for the addon
        const addonRouter = require('express').Router();

        // Add routes to both root and BASE_PATH
        const routeHandlers = {
            manifest: (req, res, next) => {
                logWithTime('Manifest request:', {
                    headers: req.headers,
                    platform: req.stremioInfo?.platform
                });
                next();
            },
            catalog: (req, res, next) => {
                const searchQuery = req.query.search || 
                                  (req.params.extra && decodeURIComponent(req.params.extra));
                
                logWithTime('Catalog/Search request:', {
                    type: req.params.type,
                    id: req.params.id,
                    extra: req.params.extra,
                    query: req.query,
                    search: searchQuery,
                    headers: req.headers,
                    url: req.url
                });
                next();
            },
            ping: (req, res) => {
                res.json({
                    status: 'ok',
                    timestamp: new Date().toISOString(),
                    platform: req.stremioInfo?.platform || 'unknown',
                    path: req.path
                });
            },
            meta: (req, res, next) => {
                logWithTime('Meta request:', {
                    type: req.params.type,
                    id: req.params.id,
                    extra: req.params.extra,
                    query: req.query,
                    search: req.query.search,
                    headers: req.headers,
                    url: req.url
                });
                next();
            }
        };

        // Mount routes at both root and BASE_PATH
        ['/'].forEach(path => {
            addonRouter.get(path + 'manifest.json', routeHandlers.manifest);
            addonRouter.get(path + 'catalog/:type/:id/:extra?.json', routeHandlers.catalog);
            addonRouter.get(path + 'ping', routeHandlers.ping);
        });

        // Mount the Stremio addon SDK router
        const { getRouter } = require('stremio-addon-sdk');
        const stremioRouter = getRouter(addonInterface);

        // Use the Stremio router for both paths
        addonRouter.use('/', stremioRouter);

        // Mount the addon router at both root and BASE_PATH
        app.use('/', addonRouter);
        app.use(BASE_PATH, addonRouter);

        // Add static file serving for the configure page
        app.use(express.static('public'));

        // Update the manifest route to include user data
        addonRouter.get('/:userData?/manifest.json', (req, res) => {
            const manifest = {
                ...addonInterface.manifest,
                behaviorHints: {
                    ...addonInterface.manifest.behaviorHints,
                    configurable: true,
                    configurationRequired: true
                }
            };
            res.json(manifest);
        });

        // Update other routes to use userData
        addonRouter.get('/:userData/catalog/:type/:id/:extra?.json', routeHandlers.catalog);
        addonRouter.get('/:userData/meta/:type/:id.json', routeHandlers.meta);

        // Start server without HTTP/2
        app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
            logWithTime('Server started successfully! 🚀');
            const domain = 'https://stremio.itcon.au';
            logWithTime('Server is accessible at root:', `${domain}/manifest.json`);
            logWithTime('Server is accessible at base path:', `${domain}${BASE_PATH}/manifest.json`);
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