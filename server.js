try {
  require("dotenv").config();
} catch (error) {
  console.warn("dotenv module not found, continuing without .env file support");
}

const { serveHTTP } = require("stremio-addon-sdk");
const { addonInterface, catalogHandler } = require("./addon");
const express = require("express");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const logger = require("./utils/logger");
const { handleIssueSubmission } = require("./utils/issueHandler");
const {
  encryptConfig,
  decryptConfig,
  isValidEncryptedFormat,
} = require("./utils/crypto");
const zlib = require("zlib");

// Cache persistence configuration
const CACHE_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_FOLDER = path.join(__dirname, "cache_data");

// Ensure cache folder exists
if (!fs.existsSync(CACHE_FOLDER)) {
  fs.mkdirSync(CACHE_FOLDER, { recursive: true });
}

// Function to save all caches to files
async function saveCachesToFiles() {
  try {
    const { serializeAllCaches } = require("./addon");
    const allCaches = serializeAllCaches();

    // Create an array to store promises for all file write operations
    const savePromises = [];
    const results = {};

    // Save each cache to its own file
    for (const [cacheName, cacheData] of Object.entries(allCaches)) {
      const cacheFilePath = path.join(CACHE_FOLDER, `${cacheName}.json.gz`);

      // Add the promise to the array
      savePromises.push(
        new Promise((resolve, reject) => {
          try {
            // Convert to JSON without pretty printing
            const jsonData = JSON.stringify(cacheData);

            // Compress the data
            const compressed = zlib.gzipSync(jsonData);

            // Write the compressed data to file
            fs.promises
              .writeFile(cacheFilePath, compressed)
              .then(() => {
                results[cacheName] = {
                  success: true,
                  size: cacheData.entries.length,
                  originalSize: jsonData.length,
                  compressedSize: compressed.length,
                  compressionRatio:
                    ((compressed.length / jsonData.length) * 100).toFixed(2) +
                    "%",
                  path: cacheFilePath,
                };
                resolve();
              })
              .catch((err) => {
                logger.error(`Error saving ${cacheName} to file`, {
                  error: err.message,
                  stack: err.stack,
                });
                results[cacheName] = {
                  success: false,
                  error: err.message,
                };
                resolve(); // Resolve anyway to continue with other caches
              });
          } catch (err) {
            logger.error(`Error compressing ${cacheName}`, {
              error: err.message,
              stack: err.stack,
            });
            results[cacheName] = {
              success: false,
              error: err.message,
            };
            resolve(); // Resolve anyway to continue with other caches
          }
        })
      );
    }

    // Wait for all files to be written
    await Promise.all(savePromises);

    logger.info("Cache data saved to individual compressed files", {
      timestamp: new Date().toISOString(),
      cacheFolder: CACHE_FOLDER,
      results,
    });

    return {
      success: true,
      timestamp: new Date().toISOString(),
      cacheFolder: CACHE_FOLDER,
      results,
    };
  } catch (error) {
    logger.error("Error saving cache data to files", {
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

// Function to load caches from files
async function loadCachesFromFiles() {
  try {
    // Check if cache folder exists
    if (!fs.existsSync(CACHE_FOLDER)) {
      logger.info("No cache folder found, starting with empty caches", {
        cacheFolder: CACHE_FOLDER,
      });
      return {
        success: false,
        reason: "No cache folder found",
      };
    }

    // Get all cache files (both compressed and uncompressed for backward compatibility)
    const files = fs
      .readdirSync(CACHE_FOLDER)
      .filter((file) => file.endsWith(".json.gz") || file.endsWith(".json"));

    if (files.length === 0) {
      logger.info("No cache files found, starting with empty caches", {
        cacheFolder: CACHE_FOLDER,
      });
      return {
        success: false,
        reason: "No cache files found",
      };
    }

    // Create an object to hold all cache data
    const allCacheData = {};
    const results = {};

    // Read each cache file
    for (const file of files) {
      try {
        const isCompressed = file.endsWith(".json.gz");
        const cacheName = path.basename(
          file,
          isCompressed ? ".json.gz" : ".json"
        );
        const cacheFilePath = path.join(CACHE_FOLDER, file);

        // Read the file
        const fileData = await fs.promises.readFile(cacheFilePath);

        let cacheDataJson;
        if (isCompressed) {
          // Decompress the data
          cacheDataJson = zlib.gunzipSync(fileData).toString();
        } else {
          // Handle uncompressed files for backward compatibility
          cacheDataJson = fileData.toString("utf8");
        }

        const cacheData = JSON.parse(cacheDataJson);

        allCacheData[cacheName] = cacheData;
        results[cacheName] = {
          success: true,
          entriesCount: cacheData.entries.length,
          compressed: isCompressed,
          path: cacheFilePath,
        };
      } catch (err) {
        logger.error(`Error reading cache file ${file}`, {
          error: err.message,
          stack: err.stack,
        });
        results[file] = {
          success: false,
          error: err.message,
        };
      }
    }

    // Deserialize the caches
    const { deserializeAllCaches } = require("./addon");
    const deserializeResults = deserializeAllCaches(allCacheData);

    // Combine results
    for (const [cacheName, result] of Object.entries(deserializeResults)) {
      if (results[cacheName]) {
        results[cacheName].deserialized = result;
      }
    }

    logger.info("Cache data loaded from individual files", {
      timestamp: new Date().toISOString(),
      results,
    });

    return {
      success: true,
      results,
    };
  } catch (error) {
    logger.error("Error loading cache data from files", {
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      error: error.message,
    };
  }
}

const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

if (ENABLE_LOGGING) {
  console.log(`Logging enabled via ENABLE_LOGGING environment variable`);
}

const PORT = 7000;
const HOST = "https://stremio.itcon.au";
const BASE_PATH = "/aisearch";

const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;

const setupManifest = {
  id: "au.itcon.aisearch",
  version: "1.0.0",
  name: "AI Search",
  description: "AI-powered movie and series recommendations",
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  configurationURL: `${HOST}${BASE_PATH}/configure`,
};

const getConfiguredManifest = (geminiKey, tmdbKey) => ({
  ...setupManifest,
  behaviorHints: {
    configurable: false,
  },
  catalogs: [
    {
      type: "movie",
      id: "top",
      name: "AI Movie Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "series",
      id: "top",
      name: "AI Series Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
  ],
});

async function startServer() {
  try {
    // Load caches from files on startup
    await loadCachesFromFiles();

    // Set up periodic cache saving
    setInterval(async () => {
      await saveCachesToFiles();
    }, CACHE_BACKUP_INTERVAL_MS);

    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
      console.error(
        "CRITICAL ERROR: ENCRYPTION_KEY environment variable is missing or too short!"
      );
      console.error("The ENCRYPTION_KEY must be at least 32 characters long.");
      console.error(
        "Please set this environment variable before starting the server."
      );
      process.exit(1);
    }

    const app = express();
    app.use(require("express").json({ limit: "10mb" }));
    app.use(
      compression({
        level: 6,
        threshold: 1024,
      })
    );

    app.use((req, res, next) => {
      const host = req.hostname;

      if (host === "stremio-dev.itcon.au") {
        const path = req.originalUrl || req.url;

        const redirectUrl = `https://stremio.itcon.au${path}`;

        if (ENABLE_LOGGING) {
          logger.info("Redirecting from dev to production", {
            from: `https://${host}${path}`,
            to: redirectUrl,
          });
        }

        return res.redirect(301, redirectUrl);
      }

      next();
    });

    app.use("/aisearch", express.static(path.join(__dirname, "public")));
    app.use("/", express.static(path.join(__dirname, "public")));

    if (ENABLE_LOGGING) {
      logger.debug("Static file paths:", {
        publicDir: path.join(__dirname, "public"),
        baseUrl: HOST,
        logoUrl: `${HOST}${BASE_PATH}/logo.png`,
        bgUrl: `${HOST}${BASE_PATH}/bg.jpg`,
      });
    }

    app.use((req, res, next) => {
      if (ENABLE_LOGGING) {
        logger.info("Incoming request", {
          method: req.method,
          path: req.path,
          originalUrl: req.originalUrl || req.url,
          query: req.query,
          params: req.params,
          headers: req.headers,
          timestamp: new Date().toISOString(),
        });
      }
      next();
    });

    app.use((req, res, next) => {
      const host = req.hostname;

      if (host === "stremio-dev.itcon.au") {
        const path = req.originalUrl || req.url;
        const redirectUrl = `https://stremio.itcon.au${path}`;

        if (ENABLE_LOGGING) {
          logger.info("Redirecting from dev to production", {
            from: `https://${host}${path}`,
            to: redirectUrl,
          });
        }

        return res.redirect(301, redirectUrl);
      }

      const userAgent = req.headers["user-agent"] || "";
      const platform = req.headers["stremio-platform"] || "";

      let detectedPlatform = "unknown";
      if (
        platform.toLowerCase() === "android-tv" ||
        userAgent.toLowerCase().includes("android tv") ||
        userAgent.toLowerCase().includes("chromecast") ||
        userAgent.toLowerCase().includes("androidtv")
      ) {
        detectedPlatform = "android-tv";
      } else if (
        !userAgent.toLowerCase().includes("stremio/") &&
        (userAgent.toLowerCase().includes("android") ||
          userAgent.toLowerCase().includes("mobile") ||
          userAgent.toLowerCase().includes("phone"))
      ) {
        detectedPlatform = "mobile";
      } else if (
        userAgent.toLowerCase().includes("windows") ||
        userAgent.toLowerCase().includes("macintosh") ||
        userAgent.toLowerCase().includes("linux") ||
        userAgent.toLowerCase().includes("stremio/")
      ) {
        detectedPlatform = "desktop";
      }

      req.stremioInfo = {
        platform: detectedPlatform,
        userAgent: userAgent,
        originalPlatform: platform,
      };

      req.headers["stremio-platform"] = detectedPlatform;
      req.headers["stremio-user-agent"] = userAgent;
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.header("Cache-Control", "no-cache");

      if (ENABLE_LOGGING) {
        logger.debug("Platform info", {
          platform: req.stremioInfo?.platform,
          userAgent: req.stremioInfo?.userAgent,
          originalPlatform: req.stremioInfo?.originalPlatform,
        });
      }

      next();
    });

    const addonRouter = require("express").Router();
    const routeHandlers = {
      manifest: (req, res, next) => {
        next();
      },
      catalog: (req, res, next) => {
        const searchParam = req.params.extra?.split("search=")[1];
        const searchQuery = searchParam
          ? decodeURIComponent(searchParam)
          : req.query.search || "";
        next();
      },
      ping: (req, res) => {
        res.json({
          status: "ok",
          timestamp: new Date().toISOString(),
          platform: req.stremioInfo?.platform || "unknown",
          path: req.path,
        });
      },
    };

    ["/"].forEach((routePath) => {
      addonRouter.get(routePath + "manifest.json", (req, res) => {
        const baseManifest = {
          ...setupManifest,
          behaviorHints: {
            ...setupManifest.behaviorHints,
            configurationRequired: true,
          },
        };
        res.json(baseManifest);
      });

      addonRouter.get(routePath + ":config/manifest.json", (req, res) => {
        try {
          const encryptedConfig = req.params.config;

          req.stremioConfig = encryptedConfig;

          const manifestWithConfig = {
            ...addonInterface.manifest,
            behaviorHints: {
              ...addonInterface.manifest.behaviorHints,
              configurationRequired: !encryptedConfig,
            },
          };

          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Content-Type", "application/json");
          res.send(JSON.stringify(manifestWithConfig));
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Manifest error:", error);
          }
          res.status(500).send({ error: "Failed to serve manifest" });
        }
      });

      addonRouter.get(
        routePath + ":config/catalog/:type/:id/:extra?.json",
        (req, res, next) => {
          try {
            if (ENABLE_LOGGING) {
              logger.debug("Received catalog request", {
                type: req.params.type,
                id: req.params.id,
                extra: req.params.extra,
                query: req.query,
              });
            }

            const configParam = req.params.config;

            if (configParam && !isValidEncryptedFormat(configParam)) {
              if (ENABLE_LOGGING) {
                logger.error("Invalid encrypted config format", {
                  configLength: configParam.length,
                  configSample: configParam.substring(0, 20) + "...",
                });
              }
              return res.json({
                metas: [],
                error: "Invalid configuration format",
              });
            }

            req.stremioConfig = configParam;

            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");

            const { getRouter } = require("stremio-addon-sdk");
            const sdkRouter = getRouter(addonInterface);

            sdkRouter(req, res, (err) => {
              if (err) {
                if (ENABLE_LOGGING) {
                  logger.error("SDK router error:", { error: err });
                }
                return res.json({ metas: [] });
              }

              const searchParam = req.params.extra?.split("search=")[1];
              const searchQuery = searchParam
                ? decodeURIComponent(searchParam)
                : req.query.search || "";

              if (ENABLE_LOGGING) {
                logger.debug("Processing search query", { searchQuery });
              }

              const args = {
                type: req.params.type,
                id: req.params.id,
                extra: req.params.extra,
                config: configParam,
                search: searchQuery,
              };

              catalogHandler(args, req)
                .then((response) => {
                  const transformedMetas = (response.metas || []).map(
                    (meta) => ({
                      ...meta,
                      releaseInfo: meta.year?.toString() || "",
                      genres: (meta.genres || []).map((g) => g.toLowerCase()),
                      trailers: [],
                    })
                  );

                  if (ENABLE_LOGGING) {
                    logger.debug("Catalog handler response", {
                      metasCount: transformedMetas.length,
                    });
                  }

                  res.json({
                    metas: transformedMetas,
                    cacheAge: response.cacheAge || 3600,
                    staleAge: response.staleAge || 7200,
                  });
                })
                .catch((error) => {
                  if (ENABLE_LOGGING) {
                    logger.error("Catalog handler error:", {
                      error: error.message,
                      stack: error.stack,
                    });
                  }
                  res.json({ metas: [] });
                });
            });
          } catch (error) {
            if (ENABLE_LOGGING) {
              logger.error("Catalog route error:", {
                error: error.message,
                stack: error.stack,
              });
            }
            res.json({ metas: [] });
          }
        }
      );

      addonRouter.get(routePath + "ping", routeHandlers.ping);
      addonRouter.get(routePath + "configure", (req, res) => {
        const configurePath = path.join(__dirname, "public", "configure.html");

        if (!fs.existsSync(configurePath)) {
          return res.status(404).send("Configuration page not found");
        }

        // Read the configure.html file
        fs.readFile(configurePath, "utf8", (err, data) => {
          if (err) {
            return res.status(500).send("Error loading configuration page");
          }

          // Replace the placeholder with actual Trakt client ID
          const modifiedHtml = data.replace(
            'const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID";',
            `const TRAKT_CLIENT_ID = "${TRAKT_CLIENT_ID}";`
          );

          // Send the modified HTML
          res.send(modifiedHtml);
        });
      });

      // Add Trakt.tv OAuth callback endpoint
      addonRouter.get(routePath + "oauth/callback", async (req, res) => {
        try {
          const { code, state } = req.query;

          if (!code) {
            return res.status(400).send(`
              <html>
                <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                  <h2>Authentication Failed</h2>
                  <p>No authorization code received from Trakt.tv</p>
                  <script>
                    window.close();
                  </script>
                </body>
              </html>
            `);
          }

          // Exchange the code for an access token
          const tokenResponse = await fetch(
            "https://api.trakt.tv/oauth/token",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                code,
                client_id: TRAKT_CLIENT_ID,
                client_secret: TRAKT_CLIENT_SECRET,
                redirect_uri:
                  "https://stremio.itcon.au/aisearch/oauth/callback",
                grant_type: "authorization_code",
              }),
            }
          );

          if (!tokenResponse.ok) {
            throw new Error("Failed to exchange code for token");
          }

          const tokenData = await tokenResponse.json();

          // Send the token data back to the parent window
          res.send(`
            <html>
              <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                <h2>Authentication Successful</h2>
                <p>You can close this window now.</p>
                <script>
                  if (window.opener) {
                    window.opener.postMessage({
                      type: "TRAKT_AUTH_SUCCESS",
                      access_token: "${tokenData.access_token}",
                      refresh_token: "${tokenData.refresh_token}",
                      expires_in: ${tokenData.expires_in}
                    }, "https://stremio.itcon.au");
                    window.close();
                  }
                </script>
              </body>
            </html>
          `);
        } catch (error) {
          console.error("OAuth callback error:", error);
          res.status(500).send(`
            <html>
              <body style="background: #141414; color: #d9d9d9; font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                <h2>Authentication Error</h2>
                <p>Failed to complete authentication: ${error.message}</p>
                <script>
                  window.close();
                </script>
              </body>
            </html>
          `);
        }
      });

      // Handle configuration editing with encrypted config
      addonRouter.get(routePath + ":encryptedConfig/configure", (req, res) => {
        const { encryptedConfig } = req.params;

        if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
          return res.status(400).send("Invalid configuration format");
        }

        const configurePath = path.join(__dirname, "public", "configure.html");
        if (!fs.existsSync(configurePath)) {
          return res.status(404).send("Configuration page not found");
        }

        // Read the configure.html file
        fs.readFile(configurePath, "utf8", (err, data) => {
          if (err) {
            return res.status(500).send("Error loading configuration page");
          }

          // Replace the placeholder with actual Trakt client ID and fix image paths
          let modifiedHtml = data
            .replace(
              'const TRAKT_CLIENT_ID = "YOUR_ADDON_CLIENT_ID";',
              `const TRAKT_CLIENT_ID = "${TRAKT_CLIENT_ID}";`
            )
            .replace('src="logo.png"', `src="${BASE_PATH}/logo.png"`)
            .replace('src="bmc.png"', `src="${BASE_PATH}/bmc.png"`);

          // Add the encrypted config ID to the page
          modifiedHtml = modifiedHtml.replace(
            'value=""',
            `value="${encryptedConfig}"`
          );

          // Send the modified HTML
          res.send(modifiedHtml);
        });
      });

      // Update the getConfig endpoint to handle the full path
      addonRouter.get(routePath + "api/getConfig/:configId", (req, res) => {
        try {
          const { configId } = req.params;

          // Remove any path prefix if present
          const cleanConfigId = configId.split("/").pop();

          if (!cleanConfigId || !isValidEncryptedFormat(cleanConfigId)) {
            return res
              .status(400)
              .json({ error: "Invalid configuration format" });
          }

          const decryptedConfig = decryptConfig(cleanConfigId);
          if (!decryptedConfig) {
            return res
              .status(400)
              .json({ error: "Failed to decrypt configuration" });
          }

          // Parse and return the configuration
          const config = JSON.parse(decryptedConfig);
          res.json(config);
        } catch (error) {
          logger.error("Error getting configuration:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Internal server error" });
        }
      });

      addonRouter.get(routePath + "cache/stats", (req, res) => {
        const { getCacheStats } = require("./addon");
        res.json(getCacheStats());
      });

      // API endpoint to decrypt configuration
      addonRouter.post(routePath + "api/decrypt-config", (req, res) => {
        try {
          const { encryptedConfig } = req.body;

          if (!encryptedConfig || !isValidEncryptedFormat(encryptedConfig)) {
            return res
              .status(400)
              .json({ error: "Invalid configuration format" });
          }

          const decryptedConfig = decryptConfig(encryptedConfig);

          if (!decryptedConfig) {
            return res
              .status(400)
              .json({ error: "Failed to decrypt configuration" });
          }

          // Parse the decrypted JSON
          const config = JSON.parse(decryptedConfig);

          // Return the configuration object
          res.json(config);
        } catch (error) {
          logger.error("Error decrypting configuration:", {
            error: error.message,
            stack: error.stack,
          });
          res.status(500).json({ error: "Internal server error" });
        }
      });

      addonRouter.post(routePath + "cache/clear/tmdb", (req, res) => {
        const { clearTmdbCache } = require("./addon");
        res.json(clearTmdbCache());
      });

      addonRouter.post(routePath + "cache/clear/ai", (req, res) => {
        const { clearAiCache } = require("./addon");
        res.json(clearAiCache());
      });

      addonRouter.post(routePath + "cache/clear/rpdb", (req, res) => {
        const { clearRpdbCache } = require("./addon");
        res.json(clearRpdbCache());
      });

      addonRouter.post(routePath + "cache/clear/all", (req, res) => {
        const {
          clearTmdbCache,
          clearAiCache,
          clearRpdbCache,
        } = require("./addon");
        const tmdbResult = clearTmdbCache();
        const aiResult = clearAiCache();
        const rpdbResult = clearRpdbCache();
        res.json({
          tmdb: tmdbResult,
          ai: aiResult,
          rpdb: rpdbResult,
        });
      });

      // Add endpoint to manually save caches to files
      addonRouter.get(routePath + "cache/save", async (req, res) => {
        const result = await saveCachesToFiles();
        res.json(result);
      });
    });

    app.use("/", addonRouter);
    app.use(BASE_PATH, addonRouter);

    app.post("/encrypt", express.json(), (req, res) => {
      try {
        const configData = req.body;
        if (!configData) {
          return res.status(400).json({ error: "Missing config data" });
        }

        if (!configData.RpdbApiKey) {
          delete configData.RpdbApiKey;
        }

        const configStr = JSON.stringify(configData);
        const encryptedConfig = encryptConfig(configStr);

        if (!encryptedConfig) {
          return res.status(500).json({ error: "Encryption failed" });
        }

        return res.json({
          encryptedConfig,
          usingDefaultRpdb: !configData.RpdbApiKey && !!DEFAULT_RPDB_KEY,
        });
      } catch (error) {
        console.error("Encryption endpoint error:", error);
        return res.status(500).json({ error: "Server error" });
      }
    });

    app.post("/decrypt", express.json(), (req, res) => {
      try {
        const { encryptedConfig } = req.body;
        if (!encryptedConfig) {
          return res.status(400).json({ error: "Missing encrypted config" });
        }

        const decryptedConfig = decryptConfig(encryptedConfig);
        if (!decryptedConfig) {
          return res.status(500).json({ error: "Decryption failed" });
        }

        try {
          const configData = JSON.parse(decryptedConfig);
          return res.json({ success: true, config: configData });
        } catch (error) {
          return res
            .status(500)
            .json({ error: "Invalid JSON in decrypted config" });
        }
      } catch (error) {
        console.error("Decryption endpoint error:", error);
        return res.status(500).json({ error: "Server error" });
      }
    });

    app.use(
      ["/encrypt", "/decrypt", "/aisearch/encrypt", "/aisearch/decrypt"],
      (req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

        if (req.method === "OPTIONS") {
          return res.sendStatus(200);
        }

        next();
      }
    );

    app.use(["/validate", "/aisearch/validate"], (req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }

      next();
    });

    app.post("/aisearch/validate", express.json(), async (req, res) => {
      const startTime = Date.now();
      try {
        const { GeminiApiKey, TmdbApiKey, GeminiModel, TraktAccessToken } =
          req.body;
        const validationResults = {
          gemini: false,
          tmdb: false,
          trakt: true,
          errors: {},
        };
        const modelToUse = GeminiModel || "gemini-2.0-flash";

        if (ENABLE_LOGGING) {
          logger.debug("Validation request received", {
            timestamp: new Date().toISOString(),
            requestId: req.id || Math.random().toString(36).substring(7),
            geminiKeyLength: GeminiApiKey?.length || 0,
            tmdbKeyLength: TmdbApiKey?.length || 0,
            hasTraktConfig: !!TraktAccessToken,
            geminiModel: modelToUse,
            geminiKeyMasked: GeminiApiKey
              ? `${GeminiApiKey.slice(0, 4)}...${GeminiApiKey.slice(-4)}`
              : null,
            tmdbKeyMasked: TmdbApiKey
              ? `${TmdbApiKey.slice(0, 4)}...${TmdbApiKey.slice(-4)}`
              : null,
          });
        }

        // Validate TMDB key
        try {
          const tmdbUrl = `https://api.themoviedb.org/3/authentication/token/new?api_key=${TmdbApiKey}&language=en-US`;
          if (ENABLE_LOGGING) {
            logger.debug("Making TMDB validation request", {
              url: tmdbUrl.replace(TmdbApiKey, "***"),
              method: "GET",
              timestamp: new Date().toISOString(),
            });
          }

          const tmdbStartTime = Date.now();
          const tmdbResponse = await fetch(tmdbUrl);
          const tmdbData = await tmdbResponse.json();
          const tmdbDuration = Date.now() - tmdbStartTime;

          if (ENABLE_LOGGING) {
            logger.debug("TMDB validation response", {
              status: tmdbResponse.status,
              success: tmdbData.success,
              duration: `${tmdbDuration}ms`,
              payload: {
                ...tmdbData,
                request_token: tmdbData.request_token ? "***" : undefined, // Mask sensitive data
              },
              headers: {
                contentType: tmdbResponse.headers.get("content-type"),
                server: tmdbResponse.headers.get("server"),
              },
            });
          }

          validationResults.tmdb = tmdbData.success === true;
          if (!validationResults.tmdb) {
            validationResults.errors.tmdb = "Invalid TMDB API key";
          }
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("TMDB validation error:", {
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString(),
            });
          }
          validationResults.errors.tmdb = "TMDB API validation failed";
        }

        // Validate Gemini key
        try {
          if (ENABLE_LOGGING) {
            logger.debug("Initializing Gemini validation", {
              timestamp: new Date().toISOString(),
              model: modelToUse,
            });
          }

          const { GoogleGenerativeAI } = require("@google/generative-ai");
          const genAI = new GoogleGenerativeAI(GeminiApiKey);
          const model = genAI.getGenerativeModel({ model: modelToUse });
          const prompt = "Test prompt for validation.";

          if (ENABLE_LOGGING) {
            logger.debug("Making Gemini validation request", {
              model: modelToUse,
              promptLength: prompt.length,
              prompt: prompt,
              timestamp: new Date().toISOString(),
            });
          }

          const geminiStartTime = Date.now();
          const result = await model.generateContent(prompt);
          const geminiDuration = Date.now() - geminiStartTime;

          if (ENABLE_LOGGING) {
            logger.debug("Gemini raw response", {
              timestamp: new Date().toISOString(),
              response: JSON.stringify(result, null, 2),
              candidates: result.response?.candidates,
              promptFeedback: result.response?.promptFeedback,
            });
          }

          const responseText =
            result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

          if (ENABLE_LOGGING) {
            logger.debug("Gemini validation response", {
              hasResponse: !!result,
              responseLength: responseText.length,
              duration: `${geminiDuration}ms`,
              payload: {
                text: responseText,
                finishReason:
                  result?.response?.promptFeedback?.blockReason || "completed",
                safetyRatings: result?.response?.candidates?.[0]?.safetyRatings,
                citationMetadata:
                  result?.response?.candidates?.[0]?.citationMetadata,
                finishMessage: result?.response?.candidates?.[0]?.finishMessage,
              },
              status: {
                code: result?.response?.candidates?.[0]?.status?.code,
                message: result?.response?.candidates?.[0]?.status?.message,
              },
            });
          }

          validationResults.gemini = responseText.length > 0;
          if (!validationResults.gemini) {
            validationResults.errors.gemini =
              "Invalid Gemini API key - No response text received";
          }
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Gemini validation error:", {
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString(),
            });
          }
          validationResults.errors.gemini = `Invalid Gemini API key: ${error.message}`;
        }

        // Validate Trakt configuration if provided
        if (TraktAccessToken) {
          try {
            const traktResponse = await fetch(`${TRAKT_API_BASE}/users/me`, {
              headers: {
                "Content-Type": "application/json",
                "trakt-api-version": "2",
                "trakt-api-key": TRAKT_CLIENT_ID,
                Authorization: `Bearer ${TraktAccessToken}`,
              },
            });

            if (!traktResponse.ok) {
              validationResults.trakt = false;
              validationResults.errors.trakt = "Invalid Trakt.tv access token";
            }
          } catch (error) {
            validationResults.trakt = false;
            validationResults.errors.trakt = "Trakt.tv API validation failed";
          }
        }

        if (ENABLE_LOGGING) {
          logger.debug("API key validation results:", {
            tmdbValid: validationResults.tmdb,
            geminiValid: validationResults.gemini,
            traktValid: validationResults.trakt,
            errors: validationResults.errors,
            totalDuration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString(),
          });
        }

        res.json(validationResults);
      } catch (error) {
        if (ENABLE_LOGGING) {
          logger.error("Validation endpoint error:", {
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString(),
          });
        }
        res.status(500).json({
          error: "Validation failed",
          message: error.message,
        });
      }
    });

    app.get("/validate", (req, res) => {
      res.send(`
        <html>
          <head>
            <title>API Key Validation</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
              .form-group { margin-bottom: 15px; }
              label { display: block; margin-bottom: 5px; }
              input[type="text"] { width: 100%; padding: 8px; box-sizing: border-box; }
              button { padding: 10px 15px; background: #4CAF50; color: white; border: none; cursor: pointer; }
              #result { margin-top: 20px; padding: 10px; border: 1px solid #ddd; display: none; }
            </style>
          </head>
          <body>
            <h1>API Key Validation</h1>
            <div class="form-group">
              <label for="geminiKey">Gemini API Key:</label>
              <input type="text" id="geminiKey" name="GeminiApiKey">
            </div>
            <div class="form-group">
              <label for="tmdbKey">TMDB API Key:</label>
              <input type="text" id="tmdbKey" name="TmdbApiKey">
            </div>
            <button onclick="validateKeys()">Validate Keys</button>
            <div id="result"></div>
            
            <script>
              async function validateKeys() {
                const geminiKey = document.getElementById('geminiKey').value;
                const tmdbKey = document.getElementById('tmdbKey').value;
                
                if (!geminiKey || !tmdbKey) {
                  alert('Please enter both API keys');
                  return;
                }
                
                document.getElementById('result').style.display = 'block';
                document.getElementById('result').innerHTML = 'Validating...';
                
                try {
                  const response = await fetch('/validate', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      GeminiApiKey: geminiKey,
                      TmdbApiKey: tmdbKey
                    })
                  });
                  
                  const data = await response.json();
                  document.getElementById('result').innerHTML = JSON.stringify(data, null, 2);
                } catch (error) {
                  document.getElementById('result').innerHTML = 'Error: ' + error.message;
                }
              }
            </script>
          </body>
        </html>
      `);
    });

    app.get("/aisearch/validate", (req, res) => {
      res.redirect("/validate");
    });

    app.post("/validate", express.json(), async (req, res) => {
      const startTime = Date.now();
      try {
        const { GeminiApiKey, TmdbApiKey, GeminiModel, TraktAccessToken } =
          req.body;
        const validationResults = {
          gemini: false,
          tmdb: false,
          trakt: true,
          errors: {},
        };
        const modelToUse = GeminiModel || "gemini-2.0-flash";

        if (ENABLE_LOGGING) {
          logger.debug("Validation request received", {
            timestamp: new Date().toISOString(),
            requestId: req.id || Math.random().toString(36).substring(7),
            geminiKeyLength: GeminiApiKey?.length || 0,
            tmdbKeyLength: TmdbApiKey?.length || 0,
            hasTraktConfig: !!TraktAccessToken,
            geminiModel: modelToUse,
            geminiKeyMasked: GeminiApiKey
              ? `${GeminiApiKey.slice(0, 4)}...${GeminiApiKey.slice(-4)}`
              : null,
            tmdbKeyMasked: TmdbApiKey
              ? `${TmdbApiKey.slice(0, 4)}...${TmdbApiKey.slice(-4)}`
              : null,
          });
        }

        // Validate TMDB key
        try {
          const tmdbUrl = `https://api.themoviedb.org/3/authentication/token/new?api_key=${TmdbApiKey}&language=en-US`;
          if (ENABLE_LOGGING) {
            logger.debug("Making TMDB validation request", {
              url: tmdbUrl.replace(TmdbApiKey, "***"),
              method: "GET",
              timestamp: new Date().toISOString(),
            });
          }

          const tmdbStartTime = Date.now();
          const tmdbResponse = await fetch(tmdbUrl);
          const tmdbData = await tmdbResponse.json();
          const tmdbDuration = Date.now() - tmdbStartTime;

          if (ENABLE_LOGGING) {
            logger.debug("TMDB validation response", {
              status: tmdbResponse.status,
              success: tmdbData.success,
              duration: `${tmdbDuration}ms`,
              payload: {
                ...tmdbData,
                request_token: tmdbData.request_token ? "***" : undefined, // Mask sensitive data
              },
              headers: {
                contentType: tmdbResponse.headers.get("content-type"),
                server: tmdbResponse.headers.get("server"),
              },
            });
          }

          validationResults.tmdb = tmdbData.success === true;
          if (!validationResults.tmdb) {
            validationResults.errors.tmdb = "Invalid TMDB API key";
          }
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("TMDB validation error:", {
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString(),
            });
          }
          validationResults.errors.tmdb = "TMDB API validation failed";
        }

        // Validate Gemini key
        try {
          if (ENABLE_LOGGING) {
            logger.debug("Initializing Gemini validation", {
              timestamp: new Date().toISOString(),
              model: modelToUse,
            });
          }

          const { GoogleGenerativeAI } = require("@google/generative-ai");
          const genAI = new GoogleGenerativeAI(GeminiApiKey);
          const model = genAI.getGenerativeModel({ model: modelToUse });
          const prompt = "Test prompt for validation.";

          if (ENABLE_LOGGING) {
            logger.debug("Making Gemini validation request", {
              model: modelToUse,
              promptLength: prompt.length,
              prompt: prompt,
              timestamp: new Date().toISOString(),
            });
          }

          const geminiStartTime = Date.now();
          const result = await model.generateContent(prompt);
          const geminiDuration = Date.now() - geminiStartTime;

          if (ENABLE_LOGGING) {
            logger.debug("Gemini raw response", {
              timestamp: new Date().toISOString(),
              response: JSON.stringify(result, null, 2),
              candidates: result.response?.candidates,
              promptFeedback: result.response?.promptFeedback,
            });
          }

          const responseText =
            result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

          if (ENABLE_LOGGING) {
            logger.debug("Gemini validation response", {
              hasResponse: !!result,
              responseLength: responseText.length,
              duration: `${geminiDuration}ms`,
              payload: {
                text: responseText,
                finishReason:
                  result?.response?.promptFeedback?.blockReason || "completed",
                safetyRatings: result?.response?.candidates?.[0]?.safetyRatings,
                citationMetadata:
                  result?.response?.candidates?.[0]?.citationMetadata,
                finishMessage: result?.response?.candidates?.[0]?.finishMessage,
              },
              status: {
                code: result?.response?.candidates?.[0]?.status?.code,
                message: result?.response?.candidates?.[0]?.status?.message,
              },
            });
          }

          validationResults.gemini = responseText.length > 0;
          if (!validationResults.gemini) {
            validationResults.errors.gemini =
              "Invalid Gemini API key - No response text received";
          }
        } catch (error) {
          validationResults.errors.gemini = `Invalid Gemini API key: ${error.message}`;
        }

        // Validate Trakt configuration if provided
        if (TraktAccessToken) {
          try {
            const traktResponse = await fetch(`${TRAKT_API_BASE}/users/me`, {
              headers: {
                "Content-Type": "application/json",
                "trakt-api-version": "2",
                "trakt-api-key": TRAKT_CLIENT_ID,
                Authorization: `Bearer ${TraktAccessToken}`,
              },
            });

            if (!traktResponse.ok) {
              validationResults.trakt = false;
              validationResults.errors.trakt = "Invalid Trakt.tv access token";
            }
          } catch (error) {
            validationResults.trakt = false;
            validationResults.errors.trakt = "Trakt.tv API validation failed";
          }
        }

        if (ENABLE_LOGGING) {
          logger.debug("API key validation results:", {
            tmdbValid: validationResults.tmdb,
            geminiValid: validationResults.gemini,
            traktValid: validationResults.trakt,
            errors: validationResults.errors,
            totalDuration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString(),
          });
        }

        res.json(validationResults);
      } catch (error) {
        if (ENABLE_LOGGING) {
          logger.error("Validation endpoint error:", {
            error: error.message,
            stack: error.stack,
            duration: `${Date.now() - startTime}ms`,
            timestamp: new Date().toISOString(),
          });
        }
        res.status(500).json({
          error: "Validation failed",
          message: error.message,
        });
      }
    });

    app.get("/test-crypto", (req, res) => {
      try {
        const testData = JSON.stringify({
          test: "data",
          timestamp: Date.now(),
        });

        const encrypted = encryptConfig(testData);
        const decrypted = decryptConfig(encrypted);

        res.json({
          original: testData,
          encrypted: encrypted,
          decrypted: decrypted,
          success: testData === decrypted,
          encryptedLength: encrypted ? encrypted.length : 0,
          decryptedLength: decrypted ? decrypted.length : 0,
        });
      } catch (error) {
        res.status(500).json({
          error: error.message,
          stack: error.stack,
        });
      }
    });

    // Update Trakt.tv token refresh endpoint to use pre-configured credentials
    app.post("/aisearch/oauth/refresh", async (req, res) => {
      try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
          return res.status(400).json({ error: "Missing refresh token" });
        }

        const response = await fetch("https://api.trakt.tv/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            refresh_token,
            client_id: TRAKT_CLIENT_ID,
            client_secret: TRAKT_CLIENT_SECRET,
            grant_type: "refresh_token",
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to refresh token");
        }

        const tokenData = await response.json();
        res.json(tokenData);
      } catch (error) {
        console.error("Token refresh error:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // Add rate limiter for issue submissions
    const issueRateLimiter = rateLimit({
      windowMs: 60 * 60 * 1000, // 1 hour window
      max: 5, // limit each IP to 5 submissions per window
      message: {
        error:
          "Too many submissions from this IP, please try again after an hour",
      },
      standardHeaders: true,
      legacyHeaders: false,
    });

    // Add the issue submission endpoint to the addonRouter
    addonRouter.post(
      "/submit-issue",
      issueRateLimiter,
      express.json(),
      async (req, res) => {
        try {
          if (ENABLE_LOGGING) {
            logger.debug("Issue submission received", {
              title: req.body.title,
              feedbackType: req.body.feedbackType,
              email: req.body.email,
              hasRecaptcha: !!req.body.recaptchaToken,
              timestamp: new Date().toISOString(),
            });
          }

          const result = await handleIssueSubmission(req.body);
          res.json(result);
        } catch (error) {
          if (ENABLE_LOGGING) {
            logger.error("Issue submission error:", {
              error: error.message,
              stack: error.stack,
              timestamp: new Date().toISOString(),
            });
          }
          res.status(400).json({ error: error.message });
        }
      }
    );

    app.listen(PORT, "0.0.0.0", () => {
      if (ENABLE_LOGGING) {
        logger.info("Server started", {
          environment: "production",
          port: PORT,
          urls: {
            base: HOST,
            manifest: `${HOST}${BASE_PATH}/manifest.json`,
            configure: `${HOST}${BASE_PATH}/configure`,
          },
          addon: {
            id: setupManifest.id,
            version: setupManifest.version,
            name: setupManifest.name,
          },
          static: {
            publicDir: path.join(__dirname, "public"),
            logo: setupManifest.logo,
            background: setupManifest.background,
          },
        });
      }
    });
  } catch (error) {
    if (ENABLE_LOGGING) {
      logger.error("Server error:", {
        error: error.message,
        stack: error.stack,
      });
    }
    process.exit(1);
  }
}

startServer();
