require('dotenv').config();
const { serveHTTP } = require("stremio-addon-sdk");
const { builder, addonInterface, catalogHandler } = require("../addon");
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');

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

// Update the domain in your server configuration
const GITHUB_DOMAIN = 'itcon-pty-au.github.io';
const ADDON_DOMAIN = 'stremio.itcon.au';

// Update the manifest URLs to use either domain
const setupManifest = {
    id: "au.itcon.aisearch",
    version: "1.0.0",
    name: "AI Search",
    description: "AI-powered movie and series recommendations",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },
    // Use GitHub Pages URL for configuration
    configurationURL: `https://${GITHUB_DOMAIN}/stremio-ai-search/configure`
};

// Update the configured manifest
const getConfiguredManifest = (geminiKey, tmdbKey) => ({
    ...setupManifest,
    behaviorHints: {
        configurable: false
    },
    catalogs: [
        {
            type: "movie",
            id: "top",
            name: "AI Movie Search",
            extra: [{ name: "search", isRequired: true }],
            isSearch: true
        },
        {
            type: "series",
            id: "top",
            name: "AI Series Search",
            extra: [{ name: "search", isRequired: true }],
            isSearch: true
        }
    ]
});

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

        // Serve static files from public directory
        app.use(express.static(path.join(__dirname, 'public')));

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
                // Fix search query extraction
                const searchParam = req.params.extra?.split('search=')[1];
                const searchQuery = searchParam ? decodeURIComponent(searchParam) : 
                                   req.query.search || '';
                
                logWithTime('Catalog/Search request:', {
                    type: req.params.type,
                    id: req.params.id,
                    extra: req.params.extra,
                    query: req.query,
                    search: searchQuery,
                    headers: req.headers,
                    url: req.url
                });
                
                // The API keys are now set by the config route handler
                next();
            },
            ping: (req, res) => {
                res.json({
                    status: 'ok',
                    timestamp: new Date().toISOString(),
                    platform: req.stremioInfo?.platform || 'unknown',
                    path: req.path
                });
            }
        };

        // Mount routes at both root and BASE_PATH
        ['/'].forEach(routePath => {
            // Handle regular manifest request (without keys)
            addonRouter.get(routePath + 'manifest.json', (req, res) => {
                res.json(setupManifest);
            });

            // Handle manifest with config - simplified route without domain parameter
            addonRouter.get(routePath + ':config/manifest.json', (req, res) => {
                try {
                    const config = JSON.parse(decodeURIComponent(req.params.config));
                    const geminiKey = config.GeminiApiKey;
                    const tmdbKey = config.TmdbApiKey;
                    
                    if (!geminiKey || !tmdbKey) {
                        throw new Error('Missing API keys');
                    }
                    
                    res.json(getConfiguredManifest(geminiKey, tmdbKey));
                } catch (error) {
                    logError('Config parse error:', error);
                    res.json(setupManifest);
                }
            });

            // Update catalog route with detailed logging
            addonRouter.get(routePath + ':config/catalog/:type/:id/:extra?.json', (req, res, next) => {
                console.log('\n=== Starting Catalog Request ===');
                try {
                    console.log('1. Raw params:', {
                        config: req.params.config,
                        type: req.params.type,
                        id: req.params.id,
                        extra: req.params.extra
                    });

                    const config = JSON.parse(decodeURIComponent(req.params.config));
                    console.log('2. Parsed config:', {
                        geminiKey: config.GeminiApiKey ? '***' + config.GeminiApiKey.slice(-4) : 'missing',
                        tmdbKey: config.TmdbApiKey ? '***' + config.TmdbApiKey.slice(-4) : 'missing'
                    });

                    // Add config to request object for the catalog handler
                    req.stremioConfig = config;

                    // Store original res.json
                    const originalJson = res.json;
                    res.json = function(data) {
                        console.log('4. Response data:', {
                            metasCount: data.metas?.length || 0,
                            firstMeta: data.metas?.[0] ? {
                                name: data.metas[0].name,
                                year: data.metas[0].year
                            } : null
                        });
                        console.log('=== End Catalog Request ===\n');
                        return originalJson.call(this, data);
                    };
                    
                    console.log('3. Forwarding to SDK router...');
                    
                    // Use the SDK router
                    const { getRouter } = require('stremio-addon-sdk');
                    const sdkRouter = getRouter(addonInterface);
                    
                    // Forward to the SDK router
                    sdkRouter(req, res, (err) => {
                        console.log('Inside SDK router callback');
                        if (err) {
                            console.error('X. SDK router error:', err);
                            res.json({ metas: [] });
                            console.log('=== End Catalog Request (with error) ===\n');
                            return;
                        }
                        
                        // If we reach here, it means the SDK router didn't handle the request
                        console.log('SDK router did not handle the request, calling catalog handler directly...');
                        
                        const args = {
                            type: req.params.type,
                            id: req.params.id,
                            extra: req.params.extra,
                            config: req.params.config
                        };
                        
                        // Call our catalog handler function directly
                        catalogHandler(args, req)
                            .then(response => {
                                console.log('Direct catalog handler response received');
                                res.json(response);
                            })
                            .catch(error => {
                                console.error('Direct catalog handler error:', error);
                                res.json({ metas: [] });
                            })
                            .finally(() => {
                                console.log('=== End Catalog Request ===\n');
                            });
                    });

                } catch (error) {
                    console.error('X. Config parse error in catalog:', error);
                    res.json({ metas: [] });
                    console.log('=== End Catalog Request (with error) ===\n');
                }
            });

            addonRouter.get(routePath + 'ping', routeHandlers.ping);
            addonRouter.get(routePath + 'configure', (req, res) => {
                const configurePath = path.join(__dirname, 'public', 'configure.html');
                console.log('Serving configure.html from:', configurePath);
                
                // Check if file exists
                if (!fs.existsSync(configurePath)) {
                    console.error('Configure file not found at:', configurePath);
                    return res.status(404).send('Configuration page not found');
                }
                
                res.sendFile(configurePath, (err) => {
                    if (err) {
                        console.error('Error sending configure.html:', err);
                        res.status(500).send('Error loading configuration page');
                    }
                });
            });
        });

        // Mount the addon router at both root and BASE_PATH
        app.use('/', addonRouter);
        app.use(BASE_PATH, addonRouter);

        // Start server without HTTP/2
        app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
            logWithTime('Server started successfully! 🚀');
            const domain = 'https://stremio.itcon.au';
            logWithTime('Setup URL (for first-time users):', `${domain}${BASE_PATH}/manifest.json`);
            logWithTime('Full URL format:', 
                `${domain}${BASE_PATH}/<CONFIG_JSON>/manifest.json`);
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