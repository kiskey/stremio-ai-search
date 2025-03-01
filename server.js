// Load environment variables first
try {
  require("dotenv").config();
} catch (error) {
  console.warn("dotenv module not found, continuing without .env file support");
}

const { serveHTTP } = require("stremio-addon-sdk");
const { addonInterface, catalogHandler } = require("./addon");
const express = require("express");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const logger = require("./utils/logger");
const { encryptConfig, decryptConfig } = require("./utils/crypto");

const currentDir = path.basename(path.resolve(__dirname));
const isDev = currentDir.endsWith("dev");

const PORT = isDev ? 7001 : 7000;
const HOST = isDev
  ? "https://stremio-dev.itcon.au"
  : "https://stremio.itcon.au";
const BASE_PATH = "/aisearch";

const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;

const setupManifest = {
  id: isDev ? "au.itcon.aisearch.dev" : "au.itcon.aisearch",
  version: "1.0.0",
  name: isDev ? "AI Search (Dev)" : "AI Search",
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
    const app = express();
    app.use(require("express").json({ limit: "10mb" }));
    app.use(
      compression({
        level: 6,
        threshold: 1024,
      })
    );
    // Serve static files from public directory
    app.use("/aisearch", express.static(path.join(__dirname, "public")));
    app.use("/", express.static(path.join(__dirname, "public")));

    if (isDev) {
      logger.debug("Static file paths:", {
        publicDir: path.join(__dirname, "public"),
        baseUrl: HOST,
        logoUrl: `${HOST}${BASE_PATH}/logo.png`,
        bgUrl: `${HOST}${BASE_PATH}/bg.jpg`,
      });
    }

    app.use((req, res, next) => {
      logger.info("Incoming request", {
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        timestamp: new Date().toISOString(),
      });
      next();
    });

    app.use((req, res, next) => {
      logger.info("Incoming request", {
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        timestamp: new Date().toISOString(),
      });
      console.log(
        `[${new Date().toISOString()}] Request: ${req.method} ${
          req.originalUrl || req.url
        }`
      );
      console.log(
        `  Headers: ${JSON.stringify({
          "user-agent": req.headers["user-agent"],
          "stremio-platform": req.headers["stremio-platform"],
        })}`
      );
      console.log(`  Params: ${JSON.stringify(req.params)}`);
      console.log(`  Query: ${JSON.stringify(req.query)}`);
      next();
    });

    app.use((req, res, next) => {
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
        !userAgent.toLowerCase().includes("stremio/") && // Not a Stremio web app
        (userAgent.toLowerCase().includes("android") ||
          userAgent.toLowerCase().includes("mobile") ||
          userAgent.toLowerCase().includes("phone"))
      ) {
        detectedPlatform = "mobile";
      } else if (
        userAgent.toLowerCase().includes("windows") ||
        userAgent.toLowerCase().includes("macintosh") ||
        userAgent.toLowerCase().includes("linux") ||
        userAgent.toLowerCase().includes("stremio/") // Classify Stremio web app as desktop
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

      logger.debug("Platform info", {
        platform: req.stremioInfo?.platform,
        userAgent: req.stremioInfo?.userAgent,
        originalPlatform: req.stremioInfo?.originalPlatform,
      });

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
        // Always require configuration when no config is provided in URL
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

          // Store the encrypted config for later use
          req.stremioConfig = encryptedConfig;

          // Create a copy of the manifest to modify
          const manifestWithConfig = {
            ...addonInterface.manifest,
            behaviorHints: {
              ...addonInterface.manifest.behaviorHints,
              // If we have a config parameter, mark as not requiring configuration
              configurationRequired: !encryptedConfig,
            },
          };

          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Content-Type", "application/json");
          res.send(JSON.stringify(manifestWithConfig));
        } catch (error) {
          logger.error("Manifest error:", error);
          res.status(500).send({ error: "Failed to serve manifest" });
        }
      });

      addonRouter.get(
        routePath + ":config/catalog/:type/:id/:extra?.json",
        (req, res, next) => {
          try {
            logger.debug("Received catalog request", {
              type: req.params.type,
              id: req.params.id,
              extra: req.params.extra,
              query: req.query,
            });

            const configParam = req.params.config;
            req.stremioConfig = configParam;

            // Ensure proper CORS headers
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Type", "application/json");

            const { getRouter } = require("stremio-addon-sdk");
            const sdkRouter = getRouter(addonInterface);

            sdkRouter(req, res, (err) => {
              if (err) {
                logger.error("SDK router error:", { error: err });
                return res.json({ metas: [] });
              }

              const searchParam = req.params.extra?.split("search=")[1];
              const searchQuery = searchParam
                ? decodeURIComponent(searchParam)
                : req.query.search || "";

              logger.debug("Processing search query", { searchQuery });

              const args = {
                type: req.params.type,
                id: req.params.id,
                extra: req.params.extra,
                config: configParam,
                search: searchQuery,
              };

              catalogHandler(args, req)
                .then((response) => {
                  // Transform the response to match expected format
                  const transformedMetas = (response.metas || []).map(
                    (meta) => ({
                      ...meta,
                      releaseInfo: meta.year?.toString() || "",
                      genres: (meta.genres || []).map((g) => g.toLowerCase()),
                      trailers: [], // Add if you have trailer data
                    })
                  );

                  logger.debug("Catalog handler response", {
                    metasCount: transformedMetas.length,
                  });

                  res.json({
                    metas: transformedMetas,
                    cacheAge: response.cacheAge || 3600,
                    staleAge: response.staleAge || 7200,
                  });
                })
                .catch((error) => {
                  logger.error("Catalog handler error:", {
                    error: error.message,
                    stack: error.stack,
                  });
                  res.json({ metas: [] });
                });
            });
          } catch (error) {
            logger.error("Catalog route error:", {
              error: error.message,
              stack: error.stack,
            });
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

        res.sendFile(configurePath, (err) => {
          if (err) {
            res.status(500).send("Error loading configuration page");
          }
        });
      });

      addonRouter.get(routePath + "cache/stats", (req, res) => {
        const { getCacheStats } = require("./addon");
        res.json(getCacheStats());
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
          allCleared: true,
        });
      });
    });

    app.use("/", addonRouter);
    app.use(BASE_PATH, addonRouter);

    // Add this route to handle encryption
    app.post("/aisearch/encrypt", express.json(), (req, res) => {
      try {
        const configData = req.body;
        if (!configData) {
          return res.status(400).json({ error: "Missing config data" });
        }

        // If RpdbApiKey is empty string or not provided, remove it from config
        // so it will use the default key
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

    // Add this near other route handlers
    app.post("/aisearch/validate", express.json(), async (req, res) => {
      const startTime = Date.now();
      try {
        const { GeminiApiKey, TmdbApiKey } = req.body;
        const validationResults = { gemini: false, tmdb: false, errors: {} };

        // Log the validation request (with masked keys)
        logger.debug("Validation request received", {
          timestamp: new Date().toISOString(),
          requestId: req.id || Math.random().toString(36).substring(7),
          geminiKeyLength: GeminiApiKey?.length || 0,
          tmdbKeyLength: TmdbApiKey?.length || 0,
          geminiKeyMasked: GeminiApiKey
            ? `${GeminiApiKey.slice(0, 4)}...${GeminiApiKey.slice(-4)}`
            : null,
          tmdbKeyMasked: TmdbApiKey
            ? `${TmdbApiKey.slice(0, 4)}...${TmdbApiKey.slice(-4)}`
            : null,
        });

        // Validate TMDB API Key
        try {
          const tmdbUrl = `https://api.themoviedb.org/3/authentication/token/new?api_key=${TmdbApiKey}`;
          logger.debug("Making TMDB validation request", {
            url: tmdbUrl.replace(TmdbApiKey, "***"),
            method: "GET",
            timestamp: new Date().toISOString(),
          });

          const tmdbStartTime = Date.now();
          const tmdbResponse = await fetch(tmdbUrl);
          const tmdbData = await tmdbResponse.json();
          const tmdbDuration = Date.now() - tmdbStartTime;

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

          validationResults.tmdb = tmdbData.success === true;
          if (!validationResults.tmdb) {
            validationResults.errors.tmdb = "Invalid TMDB API key";
          }
        } catch (error) {
          logger.error("TMDB validation error:", {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
          });
          validationResults.errors.tmdb = "TMDB API validation failed";
        }

        // Validate Gemini API Key
        try {
          logger.debug("Initializing Gemini validation", {
            timestamp: new Date().toISOString(),
          });

          const { GoogleGenerativeAI } = require("@google/generative-ai");
          const genAI = new GoogleGenerativeAI(GeminiApiKey);
          const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
          const prompt = "Test prompt for validation.";

          logger.debug("Making Gemini validation request", {
            model: "gemini-2.0-flash",
            promptLength: prompt.length,
            prompt: prompt,
            timestamp: new Date().toISOString(),
          });

          const geminiStartTime = Date.now();
          const result = await model.generateContent(prompt);
          const geminiDuration = Date.now() - geminiStartTime;

          // Log the raw response
          logger.debug("Gemini raw response", {
            timestamp: new Date().toISOString(),
            response: JSON.stringify(result, null, 2),
            candidates: result.response?.candidates,
            promptFeedback: result.response?.promptFeedback,
          });

          const responseText =
            result.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";

          logger.debug("Gemini validation response", {
            hasResponse: !!result,
            responseLength: responseText.length,
            duration: `${geminiDuration}ms`,
            payload: {
              text: responseText,
              finishReason:
                result?.response?.promptFeedback?.blockReason || "completed",
              // Add more response details
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

          validationResults.gemini = responseText.length > 0;
          if (!validationResults.gemini) {
            validationResults.errors.gemini =
              "Invalid Gemini API key - No response text received";
          }
        } catch (error) {
          logger.error("Gemini validation error:", {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
          });
          validationResults.errors.gemini = `Invalid Gemini API key: ${error.message}`;
        }

        // Log final validation results
        logger.debug("API key validation results:", {
          tmdbValid: validationResults.tmdb,
          geminiValid: validationResults.gemini,
          errors: validationResults.errors,
          totalDuration: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        });

        res.json(validationResults);
      } catch (error) {
        logger.error("Validation endpoint error:", {
          error: error.message,
          stack: error.stack,
          duration: `${Date.now() - startTime}ms`,
          timestamp: new Date().toISOString(),
        });
        res.status(500).json({
          error: "Validation failed",
          message: error.message,
        });
      }
    });

    app.listen(PORT, "0.0.0.0", () => {
      if (isDev) {
        logger.info("Server started", {
          environment: isDev ? "development" : "production",
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
    logger.error("Server error:", { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

startServer();
