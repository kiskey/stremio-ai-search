const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch").default;
const logger = require("./utils/logger");
const path = require("path");
const { decryptConfig } = require("./utils/crypto");
const { withRetry } = require("./utils/apiRetry");
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB
const AI_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for AI
const RPDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for RPDB
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;
const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_CACHE_DURATION = Infinity; // Changed from 24 hours to infinite - historical data doesn't expire
const TRAKT_RAW_CACHE_DURATION = Infinity; // Changed from 7 days to infinite - historical data doesn't expire

class SimpleLRUCache {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.ttl = options.ttl || Infinity;
    this.cache = new Map();
    this.timestamps = new Map();
    this.expirations = new Map();
  }

  set(key, value) {
    if (this.cache.size >= this.max) {
      const oldestKey = this.timestamps.keys().next().value;
      this.delete(oldestKey);
    }

    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());

    if (this.ttl !== Infinity) {
      const expiration = Date.now() + this.ttl;
      this.expirations.set(key, expiration);
    }

    return this;
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return undefined;
    }

    this.timestamps.delete(key);
    this.timestamps.set(key, Date.now());

    return this.cache.get(key);
  }

  has(key) {
    if (!this.cache.has(key)) {
      return false;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return false;
    }

    return true;
  }

  delete(key) {
    this.cache.delete(key);
    this.timestamps.delete(key);
    this.expirations.delete(key);
    return true;
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
    this.expirations.clear();
    return true;
  }

  get size() {
    return this.cache.size;
  }

  // Serialize cache data to a JSON-friendly format
  serialize() {
    const entries = [];
    for (const [key, value] of this.cache.entries()) {
      const timestamp = this.timestamps.get(key);
      const expiration = this.expirations.get(key);
      entries.push({
        key,
        value,
        timestamp,
        expiration,
      });
    }

    return {
      max: this.max,
      ttl: this.ttl,
      entries,
    };
  }

  // Load data from serialized format
  deserialize(data) {
    if (!data || !data.entries) {
      return false;
    }

    this.max = data.max || this.max;
    this.ttl = data.ttl || this.ttl;

    // Clear existing data
    this.clear();

    // Load entries
    for (const entry of data.entries) {
      // Skip expired entries
      if (entry.expiration && Date.now() > entry.expiration) {
        continue;
      }

      this.cache.set(entry.key, entry.value);
      this.timestamps.set(entry.key, entry.timestamp);
      if (entry.expiration) {
        this.expirations.set(entry.key, entry.expiration);
      }
    }

    return true;
  }
}

const tmdbCache = new SimpleLRUCache({
  max: 25000,
  ttl: TMDB_CACHE_DURATION,
});

// Add a separate cache for TMDB details to avoid redundant API calls
const tmdbDetailsCache = new SimpleLRUCache({
  max: 25000,
  ttl: TMDB_CACHE_DURATION,
});

const aiRecommendationsCache = new SimpleLRUCache({
  max: 25000,
  ttl: AI_CACHE_DURATION,
});

const rpdbCache = new SimpleLRUCache({
  max: 25000,
  ttl: RPDB_CACHE_DURATION,
});

const HOST = "https://stremio.itcon.au";
const PORT = 7000;
const BASE_PATH = "/aisearch";

setInterval(() => {
  const tmdbStats = {
    size: tmdbCache.size,
    maxSize: tmdbCache.max,
    usagePercentage: ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbCache.size,
  };

  const tmdbDetailsStats = {
    size: tmdbDetailsCache.size,
    maxSize: tmdbDetailsCache.max,
    usagePercentage:
      ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbDetailsCache.size,
  };

  const aiStats = {
    size: aiRecommendationsCache.size,
    maxSize: aiRecommendationsCache.max,
    usagePercentage:
      (
        (aiRecommendationsCache.size / aiRecommendationsCache.max) *
        100
      ).toFixed(2) + "%",
    itemCount: aiRecommendationsCache.size,
  };

  const rpdbStats = {
    size: rpdbCache.size,
    maxSize: rpdbCache.max,
    usagePercentage: ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
    itemCount: rpdbCache.size,
  };

  logger.info("Cache statistics", {
    tmdbCache: tmdbStats,
    tmdbDetailsCache: tmdbDetailsStats,
    aiCache: aiStats,
    rpdbCache: rpdbStats,
  });
}, 60 * 60 * 1000);

const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite";

// Add separate caches for raw and processed Trakt data
const traktRawDataCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_RAW_CACHE_DURATION,
});

const traktCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_CACHE_DURATION,
});

// Helper function to merge and deduplicate Trakt items
function mergeAndDeduplicate(newItems, existingItems) {
  // Create a map of existing items by ID for quick lookup
  const existingMap = new Map();
  existingItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      existingMap.set(id, item);
    }
  });

  // Add new items, replacing existing ones if newer
  newItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      // If item exists, keep the newer one based on last_activity or just replace
      if (
        !existingMap.has(id) ||
        (item.last_activity &&
          existingMap.get(id).last_activity &&
          new Date(item.last_activity) >
            new Date(existingMap.get(id).last_activity))
      ) {
        existingMap.set(id, item);
      }
    }
  });

  // Convert map back to array
  return Array.from(existingMap.values());
}

// Modular functions for processing different aspects of Trakt data
function processGenres(watchedItems, ratedItems) {
  const genres = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(genres.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));
}

function processActors(watchedItems, ratedItems) {
  const actors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(actors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([actor, count]) => ({ actor, count }));
}

function processDirectors(watchedItems, ratedItems) {
  const directors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + 1);
      }
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + weight);
      }
    });
  });

  // Convert to sorted array
  return Array.from(directors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([director, count]) => ({ director, count }));
}

function processYears(watchedItems, ratedItems) {
  const years = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    if (year) {
      years.set(year, (years.get(year) || 0) + 1);
    }
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    const weight = item.rating / 5; // normalize rating to 0-1
    if (year) {
      years.set(year, (years.get(year) || 0) + weight);
    }
  });

  // If no years data, return null
  if (years.size === 0) {
    return null;
  }

  // Create year range object
  return {
    start: Math.min(...years.keys()),
    end: Math.max(...years.keys()),
    preferred: Array.from(years.entries()).sort((a, b) => b[1] - a[1])[0]?.[0],
  };
}

function processRatings(ratedItems) {
  const ratings = new Map();

  // Process ratings distribution
  ratedItems?.forEach((item) => {
    ratings.set(item.rating, (ratings.get(item.rating) || 0) + 1);
  });

  // Convert to sorted array
  return Array.from(ratings.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([rating, count]) => ({ rating, count }));
}

// Process all preferences in parallel
async function processPreferencesInParallel(watched, rated, history) {
  const processingStart = Date.now();

  // Run all processing functions in parallel
  const [genres, actors, directors, yearRange, ratings] = await Promise.all([
    Promise.resolve(processGenres(watched, rated)),
    Promise.resolve(processActors(watched, rated)),
    Promise.resolve(processDirectors(watched, rated)),
    Promise.resolve(processYears(watched, rated)),
    Promise.resolve(processRatings(rated)),
  ]);

  const processingTime = Date.now() - processingStart;
  logger.debug("Trakt preference processing completed", {
    processingTimeMs: processingTime,
    genresCount: genres.length,
    actorsCount: actors.length,
    directorsCount: directors.length,
    hasYearRange: !!yearRange,
    ratingsCount: ratings.length,
  });

  return {
    genres,
    actors,
    directors,
    yearRange,
    ratings,
  };
}

// Function to fetch incremental Trakt data
async function fetchTraktIncrementalData(
  clientId,
  accessToken,
  type,
  lastUpdate
) {
  // Format date for Trakt API (ISO string without milliseconds)
  const startDate = new Date(lastUpdate).toISOString().split(".")[0] + "Z";

  const endpoints = [
    `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full&start_at=${startDate}`,
    `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full&start_at=${startDate}`,
    `${TRAKT_API_BASE}/users/me/history/${type}?extended=full&start_at=${startDate}`,
  ];

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    Authorization: `Bearer ${accessToken}`,
  };

  // Fetch all data in parallel
  const responses = await Promise.all(
    endpoints.map((endpoint) =>
      fetch(endpoint, { headers })
        .then((res) => res.json())
        .catch((err) => {
          logger.error("Trakt API Error:", { endpoint, error: err.message });
          return [];
        })
    )
  );

  return {
    watched: responses[0] || [],
    rated: responses[1] || [],
    history: responses[2] || [],
  };
}

// Main function to fetch Trakt data with optimizations
async function fetchTraktWatchedAndRated(
  clientId,
  accessToken,
  type = "movies"
) {
  if (!clientId || !accessToken) {
    return null;
  }

  const rawCacheKey = `trakt_raw_${accessToken}_${type}`;
  const processedCacheKey = `trakt_${accessToken}_${type}`;

  // Check if we have processed data in cache
  if (traktCache.has(processedCacheKey)) {
    const cached = traktCache.get(processedCacheKey);
    logger.info("Trakt processed cache hit", {
      cacheKey: processedCacheKey,
      type,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
    });
    return cached.data;
  }

  // Check if we have raw data that needs updating
  let rawData;
  let isIncremental = false;

  if (traktRawDataCache.has(rawCacheKey)) {
    const cachedRaw = traktRawDataCache.get(rawCacheKey);
    const lastUpdate = cachedRaw.lastUpdate || cachedRaw.timestamp;

    // Always do incremental updates when cache exists, regardless of age
    logger.info("Performing incremental Trakt update", {
      cacheKey: rawCacheKey,
      lastUpdate: new Date(lastUpdate).toISOString(),
      age: `${Math.round((Date.now() - lastUpdate) / 1000)}s`,
    });

    try {
      // Fetch only new data since last update
      const newData = await fetchTraktIncrementalData(
        clientId,
        accessToken,
        type,
        lastUpdate
      );

      // Merge with existing data
      rawData = {
        watched: mergeAndDeduplicate(newData.watched, cachedRaw.data.watched),
        rated: mergeAndDeduplicate(newData.rated, cachedRaw.data.rated),
        history: mergeAndDeduplicate(newData.history, cachedRaw.data.history),
        lastUpdate: Date.now(),
      };

      isIncremental = true;

      // Update raw data cache
      traktRawDataCache.set(rawCacheKey, {
        timestamp: Date.now(),
        lastUpdate: Date.now(),
        data: rawData,
      });

      logger.info("Incremental Trakt update completed", {
        newWatchedCount: newData.watched.length,
        newRatedCount: newData.rated.length,
        newHistoryCount: newData.history.length,
        totalWatchedCount: rawData.watched.length,
        totalRatedCount: rawData.rated.length,
        totalHistoryCount: rawData.history.length,
      });
    } catch (error) {
      logger.error(
        "Incremental Trakt update failed, falling back to full refresh",
        {
          error: error.message,
        }
      );
      isIncremental = false;
    }
  }

  // If we don't have raw data or incremental update failed, do a full refresh
  if (!rawData) {
    logger.info("Performing full Trakt data refresh", { type });

    try {
      const fetchStart = Date.now();
      // Use the original fetch logic for a full refresh but without limits
      const endpoints = [
        `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full`,
        `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full`,
        `${TRAKT_API_BASE}/users/me/history/${type}?extended=full`,
      ];

      const headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
        Authorization: `Bearer ${accessToken}`,
      };

      const responses = await Promise.all(
        endpoints.map((endpoint) =>
          fetch(endpoint, { headers })
            .then((res) => res.json())
            .catch((err) => {
              logger.error("Trakt API Error:", {
                endpoint,
                error: err.message,
              });
              return [];
            })
        )
      );

      const fetchTime = Date.now() - fetchStart;
      const [watched, rated, history] = responses;

      rawData = {
        watched: watched || [],
        rated: rated || [],
        history: history || [],
        lastUpdate: Date.now(),
      };

      // Update raw data cache
      traktRawDataCache.set(rawCacheKey, {
        timestamp: Date.now(),
        lastUpdate: Date.now(),
        data: rawData,
      });

      logger.info("Full Trakt refresh completed", {
        fetchTimeMs: fetchTime,
        watchedCount: rawData.watched.length,
        ratedCount: rawData.rated.length,
        historyCount: rawData.history.length,
      });
    } catch (error) {
      logger.error("Trakt API Error:", {
        error: error.message,
        stack: error.stack,
      });
      return null;
    }
  }

  // Process the data (raw or incrementally updated) in parallel
  const processingStart = Date.now();
  const preferences = await processPreferencesInParallel(
    rawData.watched,
    rawData.rated,
    rawData.history
  );
  const processingTime = Date.now() - processingStart;

  // Create the final result
  const result = {
    watched: rawData.watched,
    rated: rawData.rated,
    history: rawData.history,
    preferences,
    lastUpdate: rawData.lastUpdate,
    isIncrementalUpdate: isIncremental,
  };

  // Cache the processed result
  traktCache.set(processedCacheKey, {
    timestamp: Date.now(),
    data: result,
  });

  logger.info("Trakt data processing and caching completed", {
    processingTimeMs: processingTime,
    isIncremental: isIncremental,
    cacheKey: processedCacheKey,
  });

  return result;
}

async function searchTMDB(title, type, year, tmdbKey, language = "en-US") {
  const startTime = Date.now();
  logger.debug("Starting TMDB search", { title, type, year });
  const cacheKey = `${title}-${type}-${year}-${language}`;

  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      title,
      type,
      year,
      language,
    });
    return cached.data;
  }

  logger.info("TMDB cache miss", { cacheKey, title, type, year, language });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      year: year,
      include_adult: false,
      language: language,
    });

    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;

    logger.info("Making TMDB API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: {
        type: searchType,
        query: title,
        year,
        language,
      },
    });

    // Use withRetry for the search API call
    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          const error = new Error(
            `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`
          );
          error.status = searchResponse.status;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB search API call",
      }
    );

    logger.info("TMDB API response", {
      duration: `${Date.now() - startTime}ms`,
      resultCount: responseData?.results?.length,
      firstResult: responseData?.results?.[0]
        ? {
            id: responseData.results[0].id,
            title:
              responseData.results[0].title || responseData.results[0].name,
            year:
              responseData.results[0].release_date ||
              responseData.results[0].first_air_date,
          }
        : null,
    });

    if (responseData?.results?.[0]) {
      const result = responseData.results[0];

      const tmdbData = {
        poster: result.poster_path
          ? `https://image.tmdb.org/t/p/w500${result.poster_path}`
          : null,
        backdrop: result.backdrop_path
          ? `https://image.tmdb.org/t/p/original${result.backdrop_path}`
          : null,
        tmdbRating: result.vote_average,
        genres: result.genre_ids,
        overview: result.overview || "",
        tmdb_id: result.id,
        title: result.title || result.name,
        release_date: result.release_date || result.first_air_date,
      };

      if (!tmdbData.imdb_id) {
        const detailsCacheKey = `details_${searchType}_${result.id}_${language}`;
        let detailsData;

        // Check if details are in cache
        if (tmdbDetailsCache.has(detailsCacheKey)) {
          const cachedDetails = tmdbDetailsCache.get(detailsCacheKey);
          logger.info("TMDB details cache hit", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            cachedAt: new Date(cachedDetails.timestamp).toISOString(),
            age: `${Math.round(
              (Date.now() - cachedDetails.timestamp) / 1000
            )}s`,
          });
          detailsData = cachedDetails.data;
        } else {
          // Not in cache, need to make API call
          const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${tmdbKey}&append_to_response=external_ids&language=${language}`;

          logger.info("TMDB details cache miss", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
          });

          logger.info("Making TMDB details API call", {
            url: detailsUrl.replace(tmdbKey, "***"),
            movieId: result.id,
          });

          // Use withRetry for the details API call
          detailsData = await withRetry(
            async () => {
              const detailsResponse = await fetch(detailsUrl);
              if (!detailsResponse.ok) {
                const errorData = await detailsResponse
                  .json()
                  .catch(() => ({}));
                const error = new Error(
                  `TMDB details API error: ${detailsResponse.status} ${
                    errorData?.status_message || ""
                  }`
                );
                error.status = detailsResponse.status;
                throw error;
              }
              return detailsResponse.json();
            },
            {
              maxRetries: 3,
              initialDelay: 1000,
              maxDelay: 8000,
              operationName: "TMDB details API call",
            }
          );

          logger.info("TMDB details response", {
            duration: `${Date.now() - startTime}ms`,
          });

          // Cache the details response
          tmdbDetailsCache.set(detailsCacheKey, {
            timestamp: Date.now(),
            data: detailsData,
          });

          logger.debug("TMDB details result cached", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
          });
        }

        // Extract IMDb ID from details data
        if (detailsData) {
          tmdbData.imdb_id =
            detailsData.imdb_id || detailsData.external_ids?.imdb_id;
        }
      }

      tmdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: tmdbData,
      });

      logger.debug("TMDB result cached", {
        cacheKey,
        duration: Date.now() - startTime,
        hasData: !!tmdbData,
      });
      return tmdbData;
    }

    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });
    return null;
  } catch (error) {
    logger.error("TMDB Search Error:", {
      error: error.message,
      stack: error.stack,
      params: { title, type, year, tmdbKeyLength: tmdbKey?.length },
    });
    return null;
  }
}

const manifest = {
  id: "au.itcon.aisearch",
  version: "1.0.0",
  name: "AI Search",
  description: "AI-powered movie and series recommendations",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
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
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
    searchable: true,
  },
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  contactEmail: "hi@itcon.au",
};

const builder = new addonBuilder(manifest);

/**
 * Determines the intent of a search query based on keywords
 * @param {string} query
 * @returns {"movie"|"series"|"ambiguous"}
 */
function determineIntentFromKeywords(query) {
  if (!query) return "ambiguous";

  const normalizedQuery = query.toLowerCase().trim();

  const movieKeywords = {
    strong: [
      /\bmovie(s)?\b/,
      /\bfilm(s)?\b/,
      /\bcinema\b/,
      /\bfeature\b/,
      /\bmotion picture\b/,
    ],
    medium: [
      /\bdirector\b/,
      /\bscreenplay\b/,
      /\bboxoffice\b/,
      /\btheater\b/,
      /\btheatre\b/,
      /\bcinematic\b/,
    ],
    weak: [
      /\bwatch\b/,
      /\bactor\b/,
      /\bactress\b/,
      /\bscreenwriter\b/,
      /\bproducer\b/,
    ],
  };

  const seriesKeywords = {
    strong: [
      /\bseries\b/,
      /\btv show(s)?\b/,
      /\btelevision\b/,
      /\bshow(s)?\b/,
      /\bepisode(s)?\b/,
      /\bseason(s)?\b/,
      /\bdocumentary?\b/,
      /\bdocumentaries?\b/,
    ],
    medium: [
      /\bnetflix\b/,
      /\bhbo\b/,
      /\bhulu\b/,
      /\bamazon prime\b/,
      /\bdisney\+\b/,
      /\bapple tv\+\b/,
      /\bpilot\b/,
      /\bfinale\b/,
    ],
    weak: [
      /\bcharacter\b/,
      /\bcast\b/,
      /\bplot\b/,
      /\bstoryline\b/,
      /\bnarrative\b/,
    ],
  };

  let movieScore = 0;
  let seriesScore = 0;

  for (const pattern of movieKeywords.strong) {
    if (pattern.test(normalizedQuery)) movieScore += 3;
  }

  for (const pattern of movieKeywords.medium) {
    if (pattern.test(normalizedQuery)) movieScore += 2;
  }

  for (const pattern of movieKeywords.weak) {
    if (pattern.test(normalizedQuery)) movieScore += 1;
  }

  for (const pattern of seriesKeywords.strong) {
    if (pattern.test(normalizedQuery)) seriesScore += 3;
  }

  for (const pattern of seriesKeywords.medium) {
    if (pattern.test(normalizedQuery)) seriesScore += 2;
  }

  for (const pattern of seriesKeywords.weak) {
    if (pattern.test(normalizedQuery)) seriesScore += 1;
  }

  if (/\b(netflix|hulu|hbo|disney\+|apple tv\+)\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  if (/\b(cinema|theatrical|box office|imax)\b/.test(normalizedQuery)) {
    movieScore += 1;
  }

  if (/\b\d{4}-\d{4}\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  logger.debug("Intent detection scores", {
    query: normalizedQuery,
    movieScore,
    seriesScore,
    difference: Math.abs(movieScore - seriesScore),
  });

  const scoreDifference = Math.abs(movieScore - seriesScore);
  const scoreThreshold = 2;

  if (scoreDifference < scoreThreshold) {
    return "ambiguous";
  } else if (movieScore > seriesScore) {
    return "movie";
  } else {
    return "series";
  }
}

function extractDateCriteria(query) {
  const currentYear = new Date().getFullYear();
  const q = query.toLowerCase();

  const patterns = {
    inYear: /(?:in|from|of)\s+(\d{4})/i,
    between: /between\s+(\d{4})\s+and\s+(\d{4}|today)/i,
    lastNYears: /last\s+(\d+)\s+years?/i,
    released: /released\s+in\s+(\d{4})/i,
    decade: /(?:in |from )?(?:the\s+)?(\d{2})(?:'?s|0s)|(\d{4})s/i,
    decadeWord:
      /(?:in |from )?(?:the\s+)?(sixties|seventies|eighties|nineties)/i,
    relative: /(?:newer|more recent|older) than (?:the year )?(\d{4})/i,
    modern: /modern|recent|latest|new/i,
    classic: /classic|vintage|old|retro/i,
    prePost: /(?:pre|post)-(\d{4})/i,
  };

  const decadeMap = {
    sixties: 1960,
    seventies: 1970,
    eighties: 1980,
    nineties: 1990,
  };

  for (const [type, pattern] of Object.entries(patterns)) {
    const match = q.match(pattern);
    if (match) {
      switch (type) {
        case "inYear":
          return { startYear: parseInt(match[1]), endYear: parseInt(match[1]) };

        case "between":
          const endYear =
            match[2].toLowerCase() === "today"
              ? currentYear
              : parseInt(match[2]);
          return { startYear: parseInt(match[1]), endYear };

        case "lastNYears":
          return {
            startYear: currentYear - parseInt(match[1]),
            endYear: currentYear,
          };

        case "released":
          return { startYear: parseInt(match[1]), endYear: parseInt(match[1]) };

        case "decade": {
          let decade;
          if (match[1]) {
            decade =
              match[1].length === 2
                ? (match[1] > "20" ? 1900 : 2000) + parseInt(match[1])
                : parseInt(match[1]);
          } else {
            decade = parseInt(match[2]);
          }
          return { startYear: decade, endYear: decade + 9 };
        }

        case "decadeWord": {
          const decade = decadeMap[match[1]];
          return decade ? { startYear: decade, endYear: decade + 9 } : null;
        }

        case "relative":
          const year = parseInt(match[1]);
          return q.includes("newer") || q.includes("more recent")
            ? { startYear: year, endYear: currentYear }
            : { startYear: 1900, endYear: year };

        case "modern":
          return { startYear: currentYear - 10, endYear: currentYear };

        case "classic":
          return { startYear: 1900, endYear: 1980 };

        case "prePost":
          const pivotYear = parseInt(match[1]);
          return q.startsWith("pre")
            ? { startYear: 1900, endYear: pivotYear - 1 }
            : { startYear: pivotYear + 1, endYear: currentYear };
      }
    }
  }
  return null;
}

function extractGenreCriteria(query) {
  const q = query.toLowerCase();

  const basicGenres = {
    action: /\b(action)\b/i,
    comedy: /\b(comedy|comedies|funny)\b/i,
    drama: /\b(drama|dramatic)\b/i,
    horror: /\b(horror|scary|frightening)\b/i,
    thriller: /\b(thriller|suspense)\b/i,
    romance: /\b(romance|romantic|love)\b/i,
    scifi: /\b(sci-?fi|science\s*fiction)\b/i,
    fantasy: /\b(fantasy|magical)\b/i,
    documentary: /\b(documentary|documentaries)\b/i,
    animation: /\b(animation|animated|anime)\b/i,
  };

  const subGenres = {
    cyberpunk: /\b(cyberpunk|cyber\s*punk)\b/i,
    noir: /\b(noir|neo-noir)\b/i,
    psychological: /\b(psychological)\b/i,
    superhero: /\b(superhero|comic\s*book|marvel|dc)\b/i,
    musical: /\b(musical|music)\b/i,
    war: /\b(war|military)\b/i,
    western: /\b(western|cowboy)\b/i,
    sports: /\b(sports?|athletic)\b/i,
  };

  const moods = {
    feelGood: /\b(feel-?good|uplifting|heartwarming)\b/i,
    dark: /\b(dark|gritty|disturbing)\b/i,
    thoughtProvoking: /\b(thought-?provoking|philosophical|deep)\b/i,
    intense: /\b(intense|gripping|edge.*seat)\b/i,
    lighthearted: /\b(light-?hearted|fun|cheerful)\b/i,
  };

  const combinedPattern =
    /(?:action[- ]comedy|romantic[- ]comedy|sci-?fi[- ]horror|dark[- ]comedy|romantic[- ]thriller)/i;

  const notPattern = /\b(?:not|no|except)\b\s+(\w+)/i;

  const genres = {
    include: [],
    exclude: [],
    mood: [],
    style: [],
  };

  const combinedMatch = q.match(combinedPattern);
  if (combinedMatch) {
    genres.include.push(combinedMatch[0].toLowerCase().replace(/\s+/g, "-"));
  }

  const notMatches = q.match(new RegExp(notPattern, "g"));
  if (notMatches) {
    notMatches.forEach((match) => {
      const excluded = match.match(notPattern)[1];
      genres.exclude.push(excluded.toLowerCase());
    });
  }

  for (const [genre, pattern] of Object.entries(basicGenres)) {
    if (pattern.test(q) && !genres.exclude.includes(genre)) {
      genres.include.push(genre);
    }
  }

  for (const [subgenre, pattern] of Object.entries(subGenres)) {
    if (pattern.test(q) && !genres.exclude.includes(subgenre)) {
      genres.include.push(subgenre);
    }
  }

  for (const [mood, pattern] of Object.entries(moods)) {
    if (pattern.test(q)) {
      genres.mood.push(mood);
    }
  }

  return Object.values(genres).some((arr) => arr.length > 0) ? genres : null;
}

// Add this function to better detect recommendation queries
function isRecommendationQuery(query) {
  return query.toLowerCase().trim().startsWith("recommend");
}

/**
 * Checks if an item is in the user's watch history or rated items
 * @param {Object} item - The item to check
 * @param {Array} watchHistory - The user's watch history from Trakt
 * @param {Array} ratedItems - The user's rated items from Trakt
 * @returns {boolean} - True if the item is in the watch history or rated items
 */
function isItemWatchedOrRated(item, watchHistory, ratedItems) {
  if (!item) {
    return false;
  }

  // Normalize the item name for comparison
  const normalizedName = item.name.toLowerCase().trim();
  const itemYear = parseInt(item.year);

  // Debug logging for specific items (uncomment for troubleshooting)
  // if (normalizedName.includes("specific movie title")) {
  //   logger.debug("Checking specific item", {
  //     item: { name: item.name, year: item.year },
  //     watchHistoryCount: watchHistory?.length || 0,
  //     ratedItemsCount: ratedItems?.length || 0
  //   });
  // }

  // Check if the item exists in watch history
  const isWatched =
    watchHistory &&
    watchHistory.length > 0 &&
    watchHistory.some((historyItem) => {
      const media = historyItem.movie || historyItem.show;
      if (!media) return false;

      const historyName = media.title.toLowerCase().trim();
      const historyYear = parseInt(media.year);

      const isMatch =
        normalizedName === historyName &&
        (!itemYear || !historyYear || itemYear === historyYear);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in watch history", {
      //     recommendation: { name: item.name, year: item.year },
      //     watchedItem: { title: media.title, year: media.year }
      //   });
      // }

      return isMatch;
    });

  // Check if the item exists in rated items
  const isRated =
    ratedItems &&
    ratedItems.length > 0 &&
    ratedItems.some((ratedItem) => {
      const media = ratedItem.movie || ratedItem.show;
      if (!media) return false;

      const ratedName = media.title.toLowerCase().trim();
      const ratedYear = parseInt(media.year);

      const isMatch =
        normalizedName === ratedName &&
        (!itemYear || !ratedYear || itemYear === ratedYear);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in rated items", {
      //     recommendation: { name: item.name, year: item.year },
      //     ratedItem: { title: media.title, year: media.year, rating: ratedItem.rating }
      //   });
      // }

      return isMatch;
    });

  return isWatched || isRated;
}

async function getAIRecommendations(query, type, geminiKey, config) {
  const startTime = Date.now();
  const numResults = config?.numResults || 20;
  const enableAiCache =
    config?.EnableAiCache !== undefined ? config.EnableAiCache : true;
  const geminiModel = config?.GeminiModel || DEFAULT_GEMINI_MODEL;
  const language = config?.TmdbLanguage || "en-US";
  const traktClientId = config?.TraktClientId;
  const traktAccessToken = config?.TraktAccessToken;

  logger.debug("Starting AI recommendations", {
    query,
    type,
    requestedResults: numResults,
    cacheEnabled: enableAiCache,
    model: geminiModel,
    hasTraktConfig: !!(traktClientId && traktAccessToken),
  });

  // Check if it's a recommendation query
  const isRecommendation = isRecommendationQuery(query);
  let traktData = null;
  let discoveredType = type;
  let discoveredGenres = [];
  let filteredTraktData = null;

  // For recommendation queries, use the new workflow with type and genre discovery
  if (isRecommendation) {
    // First, make the genre and type discovery API call
    const discoveryResult = await discoverTypeAndGenres(
      query,
      geminiKey,
      geminiModel
    );
    discoveredType = discoveryResult.type;
    discoveredGenres = discoveryResult.genres;

    logger.info("Genre and type discovery results", {
      query,
      discoveredType,
      discoveredGenres,
      originalType: type,
    });

    // If the discovered type is specific (not ambiguous) and doesn't match the requested type,
    // return empty results, similar to how regular searches handle intent mismatches
    if (discoveredType !== "ambiguous" && discoveredType !== type) {
      logger.debug("Recommendation intent mismatch - returning empty results", {
        discoveredType,
        requestedType: type,
        query,
        message: `This recommendation appears to be for ${discoveredType}, not ${type}`,
      });
      return {
        recommendations: {
          movies: type === "movie" ? [] : undefined,
          series: type === "series" ? [] : undefined,
        },
        fromCache: false,
      };
    }

    // If Trakt is configured, get user data
    if (traktClientId && traktAccessToken) {
      traktData = await fetchTraktWatchedAndRated(
        traktClientId,
        traktAccessToken,
        type === "movie" ? "movies" : "shows"
      );

      // Filter Trakt data based on discovered genres
      if (traktData && discoveredGenres.length > 0) {
        filteredTraktData = filterTraktDataByGenres(
          traktData,
          discoveredGenres
        );

        logger.info("Filtered Trakt data by genres", {
          genres: discoveredGenres,
          recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
          highlyRatedCount: filteredTraktData.highlyRated.length,
          lowRatedCount: filteredTraktData.lowRated.length,
        });
      }
    }
  } else {
    // For non-recommendation queries, use the original workflow
    // If it's not a recommendation query but Trakt is configured, get user data (original behavior)
    if (traktClientId && traktAccessToken) {
      traktData = await fetchTraktWatchedAndRated(
        traktClientId,
        traktAccessToken,
        type === "movie" ? "movies" : "shows"
      );
    }
  }

  const cacheKey = `${query}_${type}_${traktData ? "trakt" : "no_trakt"}`;

  // Only check cache if there's no Trakt data or if it's not a recommendation query
  if (enableAiCache && !traktData && aiRecommendationsCache.has(cacheKey)) {
    const cached = aiRecommendationsCache.get(cacheKey);

    logger.info("AI recommendations cache hit", {
      cacheKey,
      query,
      type,
      model: geminiModel,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      cachedConfigNumResults: cached.configNumResults,
      requestedResults: numResults,
      hasMovies: !!cached.data?.recommendations?.movies?.length,
      hasSeries: !!cached.data?.recommendations?.series?.length,
    });

    if (cached.configNumResults && numResults > cached.configNumResults) {
      logger.info("NumResults increased, invalidating cache", {
        oldValue: cached.configNumResults,
        newValue: numResults,
      });
      aiRecommendationsCache.delete(cacheKey);
    } else if (
      !cached.data?.recommendations ||
      (type === "movie" && !cached.data.recommendations.movies) ||
      (type === "series" && !cached.data.recommendations.series)
    ) {
      logger.error("Invalid cached data structure, forcing refresh", {
        type,
        cachedData: cached.data,
      });
      aiRecommendationsCache.delete(cacheKey);
    } else {
      return cached.data;
    }
  }

  if (!enableAiCache) {
    logger.info("AI cache bypassed (disabled in config)", {
      cacheKey,
      query,
      type,
    });
  } else if (traktData) {
    logger.info("AI cache bypassed (using Trakt personalization)", {
      cacheKey,
      query,
      type,
      hasTraktData: true,
    });
  } else {
    logger.info("AI recommendations cache miss", { cacheKey, query, type });
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: geminiModel });
    const dateCriteria = extractDateCriteria(query);
    const genreCriteria = extractGenreCriteria(query);

    let promptText = [
      `You are a ${type} recommendation expert. Analyze this query: "${query}"`,
      "",
      "QUERY ANALYSIS:",
    ];

    // Add query analysis section
    if (isRecommendation && discoveredGenres.length > 0) {
      promptText.push(`Discovered genres: ${discoveredGenres.join(", ")}`);
    } else if (genreCriteria?.include?.length > 0) {
      promptText.push(`Requested genres: ${genreCriteria.include.join(", ")}`);
    }
    if (dateCriteria) {
      promptText.push(
        `Time period: ${dateCriteria.startYear} to ${dateCriteria.endYear}`
      );
    }
    if (genreCriteria?.mood?.length > 0) {
      promptText.push(`Mood/Style: ${genreCriteria.mood.join(", ")}`);
    }
    promptText.push("");

    if (traktData) {
      const { preferences } = traktData;

      // For recommendation queries, use the filtered Trakt data
      if (isRecommendation && filteredTraktData) {
        const { recentlyWatched, highlyRated, lowRated } = filteredTraktData;

        // Calculate genre overlap if we have discovered genres
        let genreRecommendationStrategy = "";
        if (discoveredGenres.length > 0) {
          const queryGenres = new Set(
            discoveredGenres.map((g) => g.toLowerCase())
          );
          const userGenres = new Set(
            preferences.genres.map((g) => g.genre.toLowerCase())
          );
          const overlap = [...queryGenres].filter((g) => userGenres.has(g));

          if (overlap.length > 0) {
            genreRecommendationStrategy =
              "Since the requested genres match some of the user's preferred genres, " +
              "prioritize recommendations that combine these interests while maintaining the specific genre requirements.";
          } else {
            genreRecommendationStrategy =
              "Although the requested genres differ from the user's usual preferences, " +
              "try to find high-quality recommendations that might bridge their interests with the requested genres.";
          }
        }

        promptText.push(
          "USER'S WATCH HISTORY AND PREFERENCES (FILTERED BY RELEVANT GENRES):",
          "",
          "Recently watched in these genres:",
          recentlyWatched
            .slice(0, 25)
            .map((item) => {
              const media = item.movie || item.show;
              return `- ${media.title} (${media.year}) - ${
                media.genres?.join(", ") || "N/A"
              }`;
            })
            .join("\n"),
          "",
          "Highly rated (4-5 stars) in these genres:",
          highlyRated
            .slice(0, 25)
            .map((item) => {
              const media = item.movie || item.show;
              return `- ${media.title} (${item.rating}/5) - ${
                media.genres?.join(", ") || "N/A"
              }`;
            })
            .join("\n"),
          "",
          "Low rated (1-2 stars) in these genres:",
          lowRated
            .slice(0, 15)
            .map((item) => {
              const media = item.movie || item.show;
              return `- ${media.title} (${item.rating}/5) - ${
                media.genres?.join(", ") || "N/A"
              }`;
            })
            .join("\n"),
          "",
          "Top genres:",
          preferences.genres
            .map((g) => `- ${g.genre} (Score: ${g.count.toFixed(2)})`)
            .join("\n"),
          "",
          "Favorite actors:",
          preferences.actors
            .map((a) => `- ${a.actor} (Score: ${a.count.toFixed(2)})`)
            .join("\n"),
          "",
          "Preferred directors:",
          preferences.directors
            .map((d) => `- ${d.director} (Score: ${d.count.toFixed(2)})`)
            .join("\n"),
          "",
          preferences.yearRange
            ? `User tends to watch content from ${preferences.yearRange.start} to ${preferences.yearRange.end}, with a preference for ${preferences.yearRange.preferred}`
            : "",
          "",
          "RECOMMENDATION STRATEGY:",
          genreRecommendationStrategy ||
            "Balance user preferences with query requirements",
          "1. Focus on the specific requirements from the query (genres, time period, mood)",
          "2. Use user's preferences to refine choices within those requirements",
          "3. Consider their rating patterns to gauge quality preferences",
          "4. Prioritize movies with preferred actors/directors when relevant",
          "5. Include some variety while staying within the requested criteria",
          ""
        );
      } else {
        // For non-recommendation queries, use the original approach
        const { watched, rated } = traktData;

        // Calculate genre overlap if query has specific genres
        let genreRecommendationStrategy = "";
        if (genreCriteria?.include?.length > 0) {
          const queryGenres = new Set(
            genreCriteria.include.map((g) => g.toLowerCase())
          );
          const userGenres = new Set(
            preferences.genres.map((g) => g.genre.toLowerCase())
          );
          const overlap = [...queryGenres].filter((g) => userGenres.has(g));

          if (overlap.length > 0) {
            genreRecommendationStrategy =
              "Since the requested genres match some of the user's preferred genres, " +
              "prioritize recommendations that combine these interests while maintaining the specific genre requirements.";
          } else {
            genreRecommendationStrategy =
              "Although the requested genres differ from the user's usual preferences, " +
              "try to find high-quality recommendations that might bridge their interests with the requested genres.";
          }
        }

        promptText.push(
          "USER'S WATCH HISTORY AND PREFERENCES:",
          "",
          "Recently watched:",
          watched
            .slice(0, 25)
            .map((item) => {
              const media = item.movie || item.show;
              return `- ${media.title} (${media.year}) - ${
                media.genres?.join(", ") || "N/A"
              }`;
            })
            .join("\n"),
          "",
          "Highly rated (4-5 stars):",
          rated
            .filter((item) => item.rating >= 4)
            .slice(0, 25)
            .map((item) => {
              const media = item.movie || item.show;
              return `- ${media.title} (${item.rating}/5) - ${
                media.genres?.join(", ") || "N/A"
              }`;
            })
            .join("\n"),
          "",
          "Top genres:",
          preferences.genres
            .map((g) => `- ${g.genre} (Score: ${g.count.toFixed(2)})`)
            .join("\n"),
          "",
          "Favorite actors:",
          preferences.actors
            .map((a) => `- ${a.actor} (Score: ${a.count.toFixed(2)})`)
            .join("\n"),
          "",
          "Preferred directors:",
          preferences.directors
            .map((d) => `- ${d.director} (Score: ${d.count.toFixed(2)})`)
            .join("\n"),
          "",
          preferences.yearRange
            ? `User tends to watch content from ${preferences.yearRange.start} to ${preferences.yearRange.end}, with a preference for ${preferences.yearRange.preferred}`
            : "",
          "",
          "RECOMMENDATION STRATEGY:",
          genreRecommendationStrategy ||
            "Balance user preferences with query requirements",
          "1. Focus on the specific requirements from the query (genres, time period, mood)",
          "2. Use user's preferences to refine choices within those requirements",
          "3. Consider their rating patterns to gauge quality preferences",
          "4. Prioritize movies with preferred actors/directors when relevant",
          "5. Avoid recommending anything they've already watched",
          "6. Include some variety while staying within the requested criteria",
          ""
        );
      }
    }

    promptText = promptText.concat([
      "IMPORTANT INSTRUCTIONS:",
      "- If this query appears to be for a specific movie (like 'The Matrix', 'Inception'), return only that exact movie and its sequels/prequels if they exist in chronological order.",
      "- If this query is for movies from a specific franchise (like 'Mission Impossible movies, James Bond movies'), list the official entries in that franchise in chronological order.",
      "- If this query is for an actor's filmography (like 'Tom Cruise movies'), list diverse notable films featuring that actor.",
      "- For all other queries, provide diverse recommendations that best match the query.",
      "- Order your recommendations in the most appropriate way for the query (by relevance, popularity, quality, or other criteria that makes sense).",
      "",
      `Generate up to ${numResults} relevant ${type} recommendations.`,
      "",
      "FORMAT:",
      "type|name|year",
      "OR",
      "type|name (year)",
      "",
      "EXAMPLES:",
      `${type}|The Matrix|1999`,
      `${type}|The Matrix (1999)`,
      "",
      "RULES:",
      "- Use | separator",
      "- Year: YYYY format (either as separate field or in parentheses)",
      `- Type: Hardcode to "${type}"`,
      "- Only best matches that strictly match ALL query requirements",
      "- If specific genres/time periods are requested, ALL recommendations must match those criteria",
    ]);

    if (dateCriteria) {
      promptText.push(
        `- Only include ${type}s released between ${dateCriteria.startYear} and ${dateCriteria.endYear}`
      );
    }

    if (genreCriteria) {
      if (genreCriteria.include.length > 0) {
        promptText.push(
          `- Must match genres: ${genreCriteria.include.join(", ")}`
        );
      }
      if (genreCriteria.exclude.length > 0) {
        promptText.push(
          `- Exclude genres: ${genreCriteria.exclude.join(", ")}`
        );
      }
      if (genreCriteria.mood.length > 0) {
        promptText.push(`- Match mood/style: ${genreCriteria.mood.join(", ")}`);
      }
    }

    promptText = promptText.join("\n");

    logger.info("Making Gemini API call", {
      model: geminiModel,
      query,
      type,
      prompt: promptText,
      dateCriteria,
      genreCriteria,
      numResults,
    });

    // Use withRetry for the Gemini API call
    const text = await withRetry(
      async () => {
        try {
          const aiResult = await model.generateContent(promptText);
          const response = await aiResult.response;
          const responseText = response.text().trim();

          // Log successful response
          logger.info("Gemini API response", {
            duration: `${Date.now() - startTime}ms`,
            promptTokens: aiResult.promptFeedback?.tokenCount,
            candidates: aiResult.candidates?.length,
            safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
            responseTextLength: responseText.length,
            responseTextSample:
              responseText.substring(0, 100) +
              (responseText.length > 100 ? "..." : ""),
          });

          return responseText;
        } catch (error) {
          // Enhance error with status for retry logic
          logger.error("Gemini API call failed", {
            error: error.message,
            status: error.httpStatus || 500,
            stack: error.stack,
          });
          error.status = error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        // Don't retry 400 errors (bad requests)
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "Gemini API call",
      }
    );

    // Process the response text
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("type|"));

    logger.debug("Parsed recommendation lines", {
      totalLines: text.split("\n").length,
      validLines: lines.length,
    });

    const recommendations = {
      movies: type === "movie" ? [] : undefined,
      series: type === "series" ? [] : undefined,
    };

    let validRecommendations = 0;
    let invalidLines = 0;

    for (const line of lines) {
      try {
        const parts = line.split("|");

        let lineType, name, year;

        if (parts.length === 3) {
          // Handle standard format: type|name|year
          [lineType, name, year] = parts.map((s) => s.trim());
        } else if (parts.length === 2) {
          // Handle format: type|name (year)
          lineType = parts[0].trim();
          const nameWithYear = parts[1].trim();

          // Extract year from format "Name (YYYY)"
          const yearMatch = nameWithYear.match(/\((\d{4})\)$/);
          if (yearMatch) {
            year = yearMatch[1];
            name = nameWithYear
              .substring(0, nameWithYear.lastIndexOf("("))
              .trim();
          } else {
            // Try to find a 4-digit year anywhere in the string
            const anyYearMatch = nameWithYear.match(/\b(19\d{2}|20\d{2})\b/);
            if (anyYearMatch) {
              year = anyYearMatch[1];
              // Remove the year from the name
              name = nameWithYear.replace(anyYearMatch[0], "").trim();
              logger.debug("Extracted year from text", {
                original: nameWithYear,
                extractedName: name,
                extractedYear: year,
              });
            } else {
              logger.debug("Missing year in recommendation", { nameWithYear });
              invalidLines++;
              continue;
            }
          }
        } else {
          logger.debug("Invalid recommendation format", { line });
          invalidLines++;
          continue;
        }

        const yearNum = parseInt(year);

        if (!lineType || !name || isNaN(yearNum)) {
          logger.debug("Invalid recommendation data", {
            lineType,
            name,
            year,
            isValidYear: !isNaN(yearNum),
          });
          invalidLines++;
          continue;
        }

        if (lineType === type && name && yearNum) {
          if (dateCriteria) {
            if (
              yearNum < dateCriteria.startYear ||
              yearNum > dateCriteria.endYear
            ) {
              logger.debug("Recommendation outside date criteria", {
                name,
                year: yearNum,
                startYear: dateCriteria.startYear,
                endYear: dateCriteria.endYear,
              });
              continue;
            }
          }

          const item = {
            name,
            year: yearNum,
            type,
            id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
          };

          if (type === "movie") recommendations.movies.push(item);
          else if (type === "series") recommendations.series.push(item);

          validRecommendations++;
        }
      } catch (error) {
        logger.error("Error processing recommendation line", {
          line,
          error: error.message,
        });
        invalidLines++;
      }
    }

    logger.info("Recommendation processing complete", {
      validRecommendations,
      invalidLines,
      totalProcessed: lines.length,
    });

    const finalResult = {
      recommendations,
      fromCache: false,
    };

    // Filter out watched items if we have Trakt data and this is a recommendation query
    if (traktData && isRecommendation) {
      const watchHistory = traktData.watched.concat(traktData.history || []);

      // Log a summary of the user's watched and rated items for validation
      const watchedSummary = watchHistory.slice(0, 20).map((item) => {
        const media = item.movie || item.show;
        return {
          title: media.title,
          year: media.year,
          type: item.movie ? "movie" : "show",
        };
      });

      const ratedSummary = traktData.rated.slice(0, 20).map((item) => {
        const media = item.movie || item.show;
        return {
          title: media.title,
          year: media.year,
          rating: item.rating,
          type: item.movie ? "movie" : "show",
        };
      });

      logger.info("User's watch history and ratings (for validation)", {
        totalWatched: watchHistory.length,
        totalRated: traktData.rated.length,
        watchedSample: watchedSummary,
        ratedSample: ratedSummary,
      });

      // Filter out watched and rated items from recommendations
      if (finalResult.recommendations.movies) {
        // Get the list of movies before filtering
        const allMovies = [...finalResult.recommendations.movies];

        const unwatchedMovies = finalResult.recommendations.movies.filter(
          (movie) => !isItemWatchedOrRated(movie, watchHistory, traktData.rated)
        );

        // Find which movies were filtered out
        const filteredMovies = allMovies.filter(
          (movie) =>
            !unwatchedMovies.some(
              (unwatched) =>
                unwatched.name === movie.name && unwatched.year === movie.year
            )
        );

        logger.info(
          "Filtered out watched and rated movies from recommendations",
          {
            totalRecommendations: finalResult.recommendations.movies.length,
            unwatchedCount: unwatchedMovies.length,
            filteredCount:
              finalResult.recommendations.movies.length -
              unwatchedMovies.length,
            filteredMovies: filteredMovies.map((movie) => ({
              title: movie.name,
              year: movie.year,
            })),
          }
        );

        finalResult.recommendations.movies = unwatchedMovies;
      }

      if (finalResult.recommendations.series) {
        // Get the list of series before filtering
        const allSeries = [...finalResult.recommendations.series];

        const unwatchedSeries = finalResult.recommendations.series.filter(
          (series) =>
            !isItemWatchedOrRated(series, watchHistory, traktData.rated)
        );

        // Find which series were filtered out
        const filteredSeries = allSeries.filter(
          (series) =>
            !unwatchedSeries.some(
              (unwatched) =>
                unwatched.name === series.name && unwatched.year === series.year
            )
        );

        logger.info(
          "Filtered out watched and rated series from recommendations",
          {
            totalRecommendations: finalResult.recommendations.series.length,
            unwatchedCount: unwatchedSeries.length,
            filteredCount:
              finalResult.recommendations.series.length -
              unwatchedSeries.length,
            filteredSeries: filteredSeries.map((series) => ({
              title: series.name,
              year: series.year,
            })),
          }
        );

        finalResult.recommendations.series = unwatchedSeries;
      }
    }

    // Only cache if there's no Trakt data (not user-specific)
    if (!traktData) {
      aiRecommendationsCache.set(cacheKey, {
        timestamp: Date.now(),
        data: finalResult,
        configNumResults: numResults,
      });

      if (enableAiCache) {
        logger.debug("AI recommendations result cached and used", {
          cacheKey,
          duration: Date.now() - startTime,
          query,
          type,
          numResults,
        });
      } else {
        logger.debug(
          "AI recommendations result cached but not used (caching disabled for this user)",
          {
            cacheKey,
            duration: Date.now() - startTime,
            query,
            type,
            numResults,
          }
        );
      }
    } else {
      logger.debug(
        "AI recommendations with Trakt data not cached (user-specific)",
        {
          duration: Date.now() - startTime,
          query,
          type,
          numResults,
          hasTraktData: true,
        }
      );
    }

    return finalResult;
  } catch (error) {
    logger.error("Gemini API Error:", {
      error: error.message,
      stack: error.stack,
      params: { query, type, geminiKeyLength: geminiKey?.length },
    });
    return {
      recommendations: {
        movies: type === "movie" ? [] : undefined,
        series: type === "series" ? [] : undefined,
      },
    };
  }
}

async function fetchRpdbPoster(imdbId, rpdbKey, posterType = "poster-default") {
  if (!imdbId || !rpdbKey) {
    return null;
  }

  const cacheKey = `rpdb_${imdbId}_${posterType}`;

  if (rpdbCache.has(cacheKey)) {
    const cached = rpdbCache.get(cacheKey);
    logger.info("RPDB poster cache hit", {
      cacheKey,
      imdbId,
      posterType,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
    });
    return cached.data;
  }

  logger.info("RPDB poster cache miss", { cacheKey, imdbId, posterType });

  try {
    const url = `https://api.ratingposterdb.com/${rpdbKey}/imdb/${posterType}/${imdbId}.jpg`;

    logger.info("Making RPDB API call", {
      imdbId,
      posterType,
      url: url.replace(rpdbKey, "***"),
    });

    // Use withRetry for the RPDB API call
    // For poster requests, we don't need to retry 404s (missing posters)
    const posterUrl = await withRetry(
      async () => {
        const response = await fetch(url);

        // Don't retry 404s for posters - they simply don't exist
        if (response.status === 404) {
          rpdbCache.set(cacheKey, {
            timestamp: Date.now(),
            data: null,
          });
          return null;
        }

        if (!response.ok) {
          const error = new Error(`RPDB API error: ${response.status}`);
          error.status = response.status;
          throw error;
        }

        // If successful, return the URL itself
        return url;
      },
      {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 5000,
        shouldRetry: (error) =>
          error.status !== 404 && (!error.status || error.status >= 500),
        operationName: "RPDB poster API call",
      }
    );

    // Cache the result (even if null)
    rpdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: posterUrl,
    });

    logger.debug("RPDB poster result cached", {
      cacheKey,
      imdbId,
      posterType,
      found: !!posterUrl,
    });

    return posterUrl;
  } catch (error) {
    logger.error("RPDB API Error:", {
      error: error.message,
      stack: error.stack,
      imdbId,
      posterType,
    });
    return null;
  }
}

async function toStremioMeta(
  item,
  platform = "unknown",
  tmdbKey,
  rpdbKey,
  rpdbPosterType = "poster-default",
  language = "en-US"
) {
  if (!item.id || !item.name) {
    return null;
  }

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");

  const tmdbData = await searchTMDB(
    item.name,
    type,
    item.year,
    tmdbKey,
    language
  );

  if (!tmdbData || !tmdbData.imdb_id) {
    return null;
  }

  let poster = tmdbData.poster;

  if (rpdbKey && tmdbData.imdb_id) {
    const rpdbPoster = await fetchRpdbPoster(
      tmdbData.imdb_id,
      rpdbKey,
      rpdbPosterType
    );
    if (rpdbPoster) {
      poster = rpdbPoster;
      logger.debug("Using RPDB poster", {
        imdbId: tmdbData.imdb_id,
        posterType: rpdbPosterType,
        poster: rpdbPoster,
      });
    }
  }

  if (!poster) {
    return null;
  }

  const meta = {
    id: tmdbData.imdb_id,
    type: type,
    name: tmdbData.title || tmdbData.name,
    description:
      platform === "android-tv"
        ? (tmdbData.overview || "").slice(0, 200)
        : tmdbData.overview || "",
    year: parseInt(item.year) || 0,
    poster:
      platform === "android-tv" && poster.includes("/w500/")
        ? poster.replace("/w500/", "/w342/")
        : poster,
    background: tmdbData.backdrop,
    posterShape: "regular",
  };

  if (tmdbData.genres && tmdbData.genres.length > 0) {
    meta.genres = tmdbData.genres.map((id) => TMDB_GENRES[id]).filter(Boolean);
  }

  return meta;
}

function detectPlatform(extra = {}) {
  if (extra.headers?.["stremio-platform"]) {
    return extra.headers["stremio-platform"];
  }

  const userAgent = (
    extra.userAgent ||
    extra.headers?.["stremio-user-agent"] ||
    ""
  ).toLowerCase();

  if (
    userAgent.includes("android tv") ||
    userAgent.includes("chromecast") ||
    userAgent.includes("androidtv")
  ) {
    return "android-tv";
  }

  if (
    userAgent.includes("android") ||
    userAgent.includes("mobile") ||
    userAgent.includes("phone")
  ) {
    return "mobile";
  }

  if (
    userAgent.includes("windows") ||
    userAgent.includes("macintosh") ||
    userAgent.includes("linux")
  ) {
    return "desktop";
  }

  return "unknown";
}

const catalogHandler = async function (args, req) {
  const startTime = Date.now();
  const { type, extra } = args;

  try {
    const encryptedConfig = req.stremioConfig;

    if (!encryptedConfig) {
      logger.error("Missing configuration - Please configure the addon first");
      return {
        metas: [],
        error: "Please configure the addon with valid API keys first",
      };
    }

    const decryptedConfigStr = decryptConfig(encryptedConfig);
    if (!decryptedConfigStr) {
      logger.error("Invalid configuration - Please reconfigure the addon");
      return {
        metas: [],
        error: "Invalid configuration detected. Please reconfigure the addon.",
      };
    }

    const configData = JSON.parse(decryptedConfigStr);

    const geminiKey = configData.GeminiApiKey;
    const tmdbKey = configData.TmdbApiKey;
    const geminiModel = configData.GeminiModel || DEFAULT_GEMINI_MODEL;
    const language = configData.TmdbLanguage || "en-US";

    if (!geminiKey || geminiKey.length < 10) {
      logger.error("Invalid or missing Gemini API key");
      return {
        metas: [],
        error:
          "Invalid Gemini API key. Please reconfigure the addon with a valid key.",
      };
    }

    if (!tmdbKey || tmdbKey.length < 10) {
      logger.error("Invalid or missing TMDB API key");
      return {
        metas: [],
        error:
          "Invalid TMDB API key. Please reconfigure the addon with a valid key.",
      };
    }

    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";
    const numResults = parseInt(configData.NumResults) || 10;
    const enableAiCache =
      configData.EnableAiCache !== undefined ? configData.EnableAiCache : true;

    if (ENABLE_LOGGING) {
      logger.debug("Catalog handler config", {
        numResults,
        rawNumResults: configData.NumResults,
        type,
        hasGeminiKey: !!geminiKey,
        hasTmdbKey: !!tmdbKey,
        hasRpdbKey: !!rpdbKey,
        isDefaultRpdbKey: rpdbKey === DEFAULT_RPDB_KEY,
        rpdbPosterType: rpdbPosterType,
        enableAiCache: enableAiCache,
        geminiModel: geminiModel,
        language: language,
      });
    }

    if (!geminiKey || !tmdbKey) {
      logger.error("Missing API keys in catalog handler");
      return { metas: [] };
    }

    const platform = detectPlatform(extra);
    logger.debug("Platform detected", { platform, extra });

    let searchQuery = "";
    if (typeof extra === "string" && extra.includes("search=")) {
      searchQuery = decodeURIComponent(extra.split("search=")[1]);
    } else if (extra?.search) {
      searchQuery = extra.search;
    }

    if (!searchQuery) {
      logger.error("No search query provided");
      return { metas: [] };
    }

    // Check if it's a recommendation query
    const isRecommendation = isRecommendationQuery(searchQuery);
    let intent = "ambiguous";

    // For recommendation queries, we'll use the AI to determine the type
    // For other queries, we'll use the existing keyword-based approach
    if (isRecommendation) {
      logger.info("Processing recommendation query", { searchQuery });
      // Type discovery and mismatch handling happens in getAIRecommendations
      // If there's a mismatch, empty results will be returned
    } else {
      // Use the existing keyword-based approach for non-recommendation queries
      intent = determineIntentFromKeywords(searchQuery);

      if (intent !== "ambiguous" && intent !== type) {
        logger.debug("Search intent mismatch - returning empty results", {
          intent,
          type,
          searchQuery,
          message: `This search appears to be for ${intent}, not ${type}`,
        });
        return { metas: [] };
      }
    }

    try {
      const aiStartTime = Date.now();
      const aiResponse = await getAIRecommendations(
        searchQuery,
        type,
        geminiKey,
        {
          numResults,
          tmdbKey,
          rpdbKey,
          rpdbPosterType: rpdbPosterType,
          enableCache: enableAiCache,
          geminiModel: geminiModel,
          language: language,
          TraktClientId: process.env.TRAKT_CLIENT_ID,
          TraktAccessToken: configData.TraktAccessToken,
        }
      );

      logger.debug("AI recommendations received", {
        duration: Date.now() - aiStartTime,
        hasRecommendations: !!aiResponse?.recommendations,
        recommendationsCount:
          type === "movie"
            ? aiResponse?.recommendations?.movies?.length
            : aiResponse?.recommendations?.series?.length,
        isCached: aiResponse?.fromCache,
        configNumResults: numResults,
      });

      const allRecommendations =
        (type === "movie"
          ? aiResponse?.recommendations?.movies
          : aiResponse?.recommendations?.series) || [];

      const recommendations = allRecommendations.slice(0, numResults);

      logger.debug("Recommendations after filtering", {
        totalAvailable: allRecommendations.length,
        numResults: numResults,
        slicedCount: recommendations.length,
      });

      if (!recommendations.length) {
        if (isRecommendation && configData.TraktAccessToken) {
          logger.info(
            "No new recommendations found - user may have already watched or rated all recommended items",
            {
              type,
              searchQuery,
              isRecommendation: isRecommendation,
            }
          );
        } else {
          logger.error("No recommendations found after filtering", {
            type,
            searchQuery,
            aiResponse,
          });
        }
        return { metas: [] };
      }

      logger.debug("Processing recommendations", {
        count: recommendations.length,
        firstItem: recommendations[0],
      });

      const metaResults = {
        total: recommendations.length,
        successful: 0,
        failed: 0,
        failures: [],
      };

      const metaPromises = recommendations.map((item) => {
        return toStremioMeta(
          item,
          platform,
          tmdbKey,
          rpdbKey,
          rpdbPosterType,
          language
        ).catch((err) => {
          metaResults.failed++;
          metaResults.failures.push({
            item,
            error: err.message,
          });
          return null;
        });
      });

      const metas = (await Promise.all(metaPromises)).filter(Boolean);

      logger.debug("Catalog response ready", {
        duration: Date.now() - startTime,
        totalMetas: metas.length,
        firstMeta: metas[0],
        metaResults,
      });

      return { metas };
    } catch (error) {
      logger.error("Catalog processing error", {
        error: error.message,
        stack: error.stack,
      });
      return { metas: [] };
    }
  } catch (error) {
    logger.error("Catalog handler error", {
      error: error.message,
      stack: error.stack,
    });
    return { metas: [] };
  }
};

builder.defineCatalogHandler(catalogHandler);

builder.defineMetaHandler(async function (args) {
  const { type, id, config } = args;

  try {
    const decryptedConfigStr = decryptConfig(config);
    if (!decryptedConfigStr) {
      throw new Error("Failed to decrypt config data");
    }

    const configData = JSON.parse(decryptedConfigStr);

    const tmdbKey = configData.TmdbApiKey;
    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";

    if (!tmdbKey) {
      throw new Error("Missing TMDB API key in config");
    }

    const tmdbData = await searchTMDB(id, type, null, tmdbKey);
    if (tmdbData) {
      let poster = tmdbData.poster;
      if (rpdbKey && tmdbData.imdb_id) {
        const rpdbPoster = await fetchRpdbPoster(
          tmdbData.imdb_id,
          rpdbKey,
          rpdbPosterType
        );
        if (rpdbPoster) {
          poster = rpdbPoster;
        }
      }

      const meta = {
        id: tmdbData.imdb_id,
        type: type,
        name: tmdbData.title || tmdbData.name,
        description: tmdbData.overview,
        year: parseInt(tmdbData.release_date || tmdbData.first_air_date) || 0,
        poster: poster,
        background: tmdbData.backdrop,
        posterShape: "regular",
      };

      if (tmdbData.genres && tmdbData.genres.length > 0) {
        meta.genres = tmdbData.genres
          .map((id) => TMDB_GENRES[id])
          .filter(Boolean);
      }

      return { meta };
    }
  } catch (error) {
    logger.error("Meta Error:", error);
  }

  return { meta: null };
});

const TMDB_GENRES = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
};

const addonInterface = builder.getInterface();

function clearTmdbCache() {
  const size = tmdbCache.size;
  tmdbCache.clear();
  logger.info("TMDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDetailsCache() {
  const size = tmdbDetailsCache.size;
  tmdbDetailsCache.clear();
  logger.info("TMDB details cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearAiCache() {
  const size = aiRecommendationsCache.size;
  aiRecommendationsCache.clear();
  logger.info("AI recommendations cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearRpdbCache() {
  const size = rpdbCache.size;
  rpdbCache.clear();
  logger.info("RPDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktCache() {
  const size = traktCache.size;
  traktCache.clear();
  logger.info("Trakt cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktRawDataCache() {
  const size = traktRawDataCache.size;
  traktRawDataCache.clear();
  logger.info("Trakt raw data cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function getCacheStats() {
  return {
    tmdbCache: {
      size: tmdbCache.size,
      maxSize: tmdbCache.max,
      usagePercentage:
        ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    },
    tmdbDetailsCache: {
      size: tmdbDetailsCache.size,
      maxSize: tmdbDetailsCache.max,
      usagePercentage:
        ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
    },
    aiCache: {
      size: aiRecommendationsCache.size,
      maxSize: aiRecommendationsCache.max,
      usagePercentage:
        (
          (aiRecommendationsCache.size / aiRecommendationsCache.max) *
          100
        ).toFixed(2) + "%",
    },
    rpdbCache: {
      size: rpdbCache.size,
      maxSize: rpdbCache.max,
      usagePercentage:
        ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
    },
    traktCache: {
      size: traktCache.size,
      maxSize: traktCache.max,
      usagePercentage:
        ((traktCache.size / traktCache.max) * 100).toFixed(2) + "%",
    },
    traktRawDataCache: {
      size: traktRawDataCache.size,
      maxSize: traktRawDataCache.max,
      usagePercentage:
        ((traktRawDataCache.size / traktRawDataCache.max) * 100).toFixed(2) +
        "%",
    },
  };
}

// Function to serialize all caches
function serializeAllCaches() {
  return {
    tmdbCache: tmdbCache.serialize(),
    tmdbDetailsCache: tmdbDetailsCache.serialize(),
    aiRecommendationsCache: aiRecommendationsCache.serialize(),
    rpdbCache: rpdbCache.serialize(),
    traktRawDataCache: traktRawDataCache.serialize(),
    traktCache: traktCache.serialize(),
  };
}

// Function to load data into all caches
function deserializeAllCaches(data) {
  const results = {
    tmdbCache: false,
    tmdbDetailsCache: false,
    aiRecommendationsCache: false,
    rpdbCache: false,
    traktRawDataCache: false,
    traktCache: false,
  };

  if (data.tmdbCache) {
    results.tmdbCache = tmdbCache.deserialize(data.tmdbCache);
  }

  if (data.tmdbDetailsCache) {
    results.tmdbDetailsCache = tmdbDetailsCache.deserialize(
      data.tmdbDetailsCache
    );
  }

  if (data.aiRecommendationsCache) {
    results.aiRecommendationsCache = aiRecommendationsCache.deserialize(
      data.aiRecommendationsCache
    );
  }

  if (data.rpdbCache) {
    results.rpdbCache = rpdbCache.deserialize(data.rpdbCache);
  }

  if (data.traktRawDataCache) {
    results.traktRawDataCache = traktRawDataCache.deserialize(
      data.traktRawDataCache
    );
  }

  if (data.traktCache) {
    results.traktCache = traktCache.deserialize(data.traktCache);
  }

  return results;
}

/**
 * Makes an AI call to determine the content type and genres for a recommendation query
 * @param {string} query - The user's search query
 * @param {string} geminiKey - The Gemini API key
 * @param {string} geminiModel - The Gemini model to use
 * @returns {Promise<{type: string, genres: string[]}>} - The discovered type and genres
 */
async function discoverTypeAndGenres(query, geminiKey, geminiModel) {
  const genAI = new GoogleGenerativeAI(geminiKey);
  const model = genAI.getGenerativeModel({ model: geminiModel });

  const promptText = `
Analyze this recommendation query: "${query}"

Determine:
1. What type of content is being requested (movie, series, or ambiguous)
2. What genres are relevant to this query (be specific and use standard genre names)

Respond in a single line with pipe-separated format:
type|genre1,genre2,genre3

Where:
- type is one of: movie, series, ambiguous
- genres are comma-separated without spaces

Examples:
movie|action,thriller,sci-fi
series|comedy,drama
ambiguous|romance,comedy

Do not include any explanatory text before or after your response. Just the single line.
`;

  try {
    logger.info("Making genre discovery API call", {
      query,
      model: geminiModel,
    });

    // Use withRetry for the Gemini API call
    const text = await withRetry(
      async () => {
        try {
          const aiResult = await model.generateContent(promptText);
          const response = await aiResult.response;
          const responseText = response.text().trim();

          // Log successful response with more details
          logger.info("Genre discovery API response", {
            promptTokens: aiResult.promptFeedback?.tokenCount,
            candidates: aiResult.candidates?.length,
            safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
            responseTextLength: responseText.length,
            responseTextSample: responseText,
          });

          return responseText;
        } catch (error) {
          // Enhance error with status for retry logic
          logger.error("Genre discovery API call failed", {
            error: error.message,
            status: error.httpStatus || 500,
            stack: error.stack,
          });
          error.status = error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        // Don't retry 400 errors (bad requests)
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "Genre discovery API call",
      }
    );

    // Extract the first line in case there's multiple lines
    const firstLine = text.split("\n")[0].trim();

    // Try to parse the pipe-separated format
    try {
      // Split by pipe to get type and genres
      const parts = firstLine.split("|");

      if (parts.length !== 2) {
        logger.error("Invalid format in genre discovery response", {
          text: firstLine,
          parts: parts.length,
        });
        return { type: "ambiguous", genres: [] };
      }

      // Get type and normalize it
      let type = parts[0].trim().toLowerCase();
      if (type !== "movie" && type !== "series") {
        type = "ambiguous";
      }

      // Get genres
      const genres = parts[1]
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0);

      logger.info("Successfully parsed genre discovery response", {
        type: type,
        genresCount: genres.length,
        genres: genres,
      });

      return {
        type: type,
        genres: genres,
      };
    } catch (error) {
      logger.error("Failed to parse genre discovery response", {
        error: error.message,
        text: firstLine,
        fullResponse: text,
      });
      return { type: "ambiguous", genres: [] };
    }
  } catch (error) {
    logger.error("Genre discovery API error", {
      error: error.message,
      stack: error.stack,
    });
    return { type: "ambiguous", genres: [] };
  }
}

/**
 * Filters Trakt data based on specified genres
 * @param {Object} traktData - The complete Trakt data
 * @param {string[]} genres - The genres to filter by
 * @returns {Object} - The filtered Trakt data
 */
function filterTraktDataByGenres(traktData, genres) {
  if (!traktData || !genres || genres.length === 0) {
    return {
      recentlyWatched: [],
      highlyRated: [],
      lowRated: [],
    };
  }

  const { watched, rated } = traktData;
  const genreSet = new Set(genres.map((g) => g.toLowerCase()));

  // Helper function to check if an item has any of the specified genres
  const hasMatchingGenre = (item) => {
    const media = item.movie || item.show;
    if (!media || !media.genres || media.genres.length === 0) return false;

    return media.genres.some((g) => genreSet.has(g.toLowerCase()));
  };

  // Filter watched items by genre
  const recentlyWatched = (watched || []).filter(hasMatchingGenre).slice(0, 25); // Last 25 watched in these genres

  // Filter highly rated items (4-5 stars)
  const highlyRated = (rated || [])
    .filter((item) => item.rating >= 4)
    .filter(hasMatchingGenre)
    .slice(0, 25); // Top 25 highly rated

  // Filter low rated items (1-2 stars)
  const lowRated = (rated || [])
    .filter((item) => item.rating <= 2)
    .filter(hasMatchingGenre)
    .slice(0, 15); // Top 15 low rated

  return {
    recentlyWatched,
    highlyRated,
    lowRated,
  };
}

module.exports = {
  builder,
  addonInterface,
  catalogHandler,
  clearTmdbCache,
  clearTmdbDetailsCache,
  clearAiCache,
  clearRpdbCache,
  clearTraktCache,
  clearTraktRawDataCache,
  getCacheStats,
  serializeAllCaches,
  deserializeAllCaches,
  discoverTypeAndGenres,
  filterTraktDataByGenres,
};
