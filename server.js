const { serveHTTP } = require("stremio-addon-sdk");
const { addonInterface, catalogHandler } = require("./addon");
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');

const PORT = 7000;

const BASE_PATH = '/aisearch';

const setupManifest = {
    id: "au.itcon.aisearch",
    version: "1.0.0",
    name: "AI Search",
    description: "AI-powered movie and series recommendations",
    logo: "https://stremio.itcon.au/aisearch/logo.png",
    background: "https://stremio.itcon.au/aisearch/bg.png",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },
    configurationURL: "https://stremio.itcon.au/aisearch/configure"
};

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

async function startServer() {
    try {
        const app = express();
        app.use(require('express').json({ limit: '10mb' }));
        app.use(compression({
            level: 6,
            threshold: 1024
        }));
        app.use(express.static(path.join(__dirname, 'public')));
        app.use((req, res, next) => {
            next();
        });

        app.use((req, res, next) => {
            const userAgent = req.headers['user-agent'] || '';
            const platform = req.headers['stremio-platform'] || '';
            
            let detectedPlatform = 'unknown';
            if (platform.toLowerCase() === 'android-tv' || 
                userAgent.toLowerCase().includes('android tv') ||
                userAgent.toLowerCase().includes('chromecast') ||
                userAgent.toLowerCase().includes('androidtv')) {
                detectedPlatform = 'android-tv';
            }
            else if (userAgent.toLowerCase().includes('android') || 
                     userAgent.toLowerCase().includes('mobile') || 
                     userAgent.toLowerCase().includes('phone')) {
                detectedPlatform = 'mobile';
            }
            else if (userAgent.toLowerCase().includes('windows') || 
                     userAgent.toLowerCase().includes('macintosh') || 
                     userAgent.toLowerCase().includes('linux')) {
                detectedPlatform = 'desktop';
            }

            req.stremioInfo = {
                platform: detectedPlatform,
                userAgent: userAgent,
                originalPlatform: platform
            };

            req.headers['stremio-platform'] = detectedPlatform;
            req.headers['stremio-user-agent'] = userAgent;          
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.header('Cache-Control', 'no-cache');
            
            next();
        });

        const addonRouter = require('express').Router();
        const routeHandlers = {
            manifest: (req, res, next) => {
                next();
            },
            catalog: (req, res, next) => {
                const searchParam = req.params.extra?.split('search=')[1];
                const searchQuery = searchParam ? decodeURIComponent(searchParam) : 
                                   req.query.search || '';
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

        ['/'].forEach(routePath => {
            addonRouter.get(routePath + 'manifest.json', (req, res) => {
                res.json(setupManifest);
            });

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
                    res.json(setupManifest);
                }
            });

            addonRouter.get(routePath + ':config/catalog/:type/:id/:extra?.json', (req, res, next) => {
                try {

                    const config = JSON.parse(decodeURIComponent(req.params.config));
                    req.stremioConfig = config;
                    const originalJson = res.json;
                    res.json = function(data) {
                        return originalJson.call(this, data);
                    };
                   
                    const { getRouter } = require('stremio-addon-sdk');
                    const sdkRouter = getRouter(addonInterface);
                    sdkRouter(req, res, (err) => {
                        if (err) {
                            res.json({ metas: [] });
                            return;
                        }
                        
                        const args = {
                            type: req.params.type,
                            id: req.params.id,
                            extra: req.params.extra,
                            config: req.params.config
                        };
                        
                        catalogHandler(args, req)
                            .then(response => {
                                res.json(response);
                            })
                            .catch(error => {
                                res.json({ metas: [] });
                            })
                            .finally(() => {
                            });
                    });

                } catch (error) {
                    res.json({ metas: [] });
                }
            });

            addonRouter.get(routePath + 'ping', routeHandlers.ping);
            addonRouter.get(routePath + 'configure', (req, res) => {
                const configurePath = path.join(__dirname, 'public', 'configure.html');
                
                if (!fs.existsSync(configurePath)) {
                    return res.status(404).send('Configuration page not found');
                }
                
                res.sendFile(configurePath, (err) => {
                    if (err) {
                        res.status(500).send('Error loading configuration page');
                    }
                });
            });
        });

        app.use('/', addonRouter);
        app.use(BASE_PATH, addonRouter);
        app.listen(PORT, '0.0.0.0', () => {});

    } catch (error) {
        process.exit(1);
    }
}

startServer();