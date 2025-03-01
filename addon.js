const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch").default;
const logger = require("./utils/logger");
const path = require("path");
const { decryptConfig } = require("./utils/crypto");

// Add these missing constants back
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;
const AI_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;
const GEMINI_MODEL = "gemini-2.0-flash";
const RPDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000;

// Near the top of the file, after other const declarations
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;

// Add this line instead
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;

// Replace the LRU cache import with this simple LRU cache implementation
class SimpleLRUCache {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.ttl = options.ttl || Infinity;
    this.cache = new Map();
    this.timestamps = new Map();
    this.expirations = new Map();
  }

  set(key, value) {
    // If cache is full, remove the oldest item
    if (this.cache.size >= this.max) {
      const oldestKey = this.timestamps.keys().next().value;
      this.delete(oldestKey);
    }

    // Add the new item
    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());

    // Set expiration if ttl is provided
    if (this.ttl !== Infinity) {
      const expiration = Date.now() + this.ttl;
      this.expirations.set(key, expiration);
    }

    return this;
  }

  get(key) {
    // Check if item exists
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Check if item is expired
    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return undefined;
    }

    // Update timestamp (recently used)
    this.timestamps.delete(key);
    this.timestamps.set(key, Date.now());

    return this.cache.get(key);
  }

  has(key) {
    if (!this.cache.has(key)) {
      return false;
    }

    // Check if item is expired
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
}

const tmdbCache = new SimpleLRUCache({
  max: 25000, // Maximum number of items to store
  ttl: TMDB_CACHE_DURATION, // Time to live in milliseconds
});

const aiRecommendationsCache = new SimpleLRUCache({
  max: 25000, // Maximum number of items to store
  ttl: AI_CACHE_DURATION, // Time to live in milliseconds
});

// Add RPDB cache
const rpdbCache = new SimpleLRUCache({
  max: 25000, // Maximum number of items to store
  ttl: RPDB_CACHE_DURATION, // Time to live in milliseconds
});

const HOST = "https://stremio.itcon.au";
const PORT = 7000;
const BASE_PATH = "/aisearch";

// Log cache stats periodically
setInterval(() => {
  const tmdbStats = {
    size: tmdbCache.size,
    maxSize: tmdbCache.max,
    usagePercentage: ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbCache.size,
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
    aiCache: aiStats,
    rpdbCache: rpdbStats,
  });
}, 60 * 60 * 1000); // Log every hour

async function searchTMDB(title, type, year, tmdbKey) {
  const startTime = Date.now();
  logger.debug("Starting TMDB search", { title, type, year });

  const cacheKey = `${title}-${type}-${year}`;

  // Updated cache check with enhanced logging
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
    });
    return cached.data;
  }

  logger.info("TMDB cache miss", { cacheKey, title, type, year });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      year: year,
      include_adult: false,
      language: "en-US",
    });

    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;

    logger.info("Making TMDB API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: {
        type: searchType,
        query: title,
        year,
        language: "en-US",
      },
    });

    const searchResponse = await fetch(searchUrl);
    const responseData = await searchResponse.json();

    logger.info("TMDB API response", {
      duration: `${Date.now() - startTime}ms`,
      status: searchResponse.status,
      headers: Object.fromEntries(searchResponse.headers),
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

    if (!searchResponse.ok) {
      throw new Error(
        `TMDB API error: ${searchResponse.status} ${
          responseData?.status_message || ""
        }`
      );
    }

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
        const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${tmdbKey}&append_to_response=external_ids`;

        logger.info("Making TMDB details API call", {
          url: detailsUrl.replace(tmdbKey, "***"),
          movieId: result.id,
        });

        const detailsResponse = await fetch(detailsUrl);
        const details = await detailsResponse.json();

        logger.info("TMDB details response", {
          status: detailsResponse.status,
          headers: Object.fromEntries(detailsResponse.headers),
          hasImdbId: !!details?.external_ids?.imdb_id,
        });

        if (details?.external_ids?.imdb_id) {
          tmdbData.imdb_id = details.external_ids.imdb_id;
        }
      }

      // Updated cache storage
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

    // Cache negative results too
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
 * @param {string} query - The search query
 * @returns {"movie"|"series"|"ambiguous"} - The detected intent
 */
function determineIntentFromKeywords(query) {
  if (!query) return "ambiguous";

  const normalizedQuery = query.toLowerCase().trim();

  // Define keyword patterns with weights
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

  // Calculate scores
  let movieScore = 0;
  let seriesScore = 0;

  // Check movie keywords
  for (const pattern of movieKeywords.strong) {
    if (pattern.test(normalizedQuery)) movieScore += 3;
  }

  for (const pattern of movieKeywords.medium) {
    if (pattern.test(normalizedQuery)) movieScore += 2;
  }

  for (const pattern of movieKeywords.weak) {
    if (pattern.test(normalizedQuery)) movieScore += 1;
  }

  // Check series keywords
  for (const pattern of seriesKeywords.strong) {
    if (pattern.test(normalizedQuery)) seriesScore += 3;
  }

  for (const pattern of seriesKeywords.medium) {
    if (pattern.test(normalizedQuery)) seriesScore += 2;
  }

  for (const pattern of seriesKeywords.weak) {
    if (pattern.test(normalizedQuery)) seriesScore += 1;
  }

  // Check for specific streaming platforms that primarily offer series
  if (/\b(netflix|hulu|hbo|disney\+|apple tv\+)\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  // Check for specific movie-related terms
  if (/\b(cinema|theatrical|box office|imax)\b/.test(normalizedQuery)) {
    movieScore += 1;
  }

  // Check for year ranges which might indicate series runs
  if (/\b\d{4}-\d{4}\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  // Log the scores for debugging
  logger.debug("Intent detection scores", {
    query: normalizedQuery,
    movieScore,
    seriesScore,
    difference: Math.abs(movieScore - seriesScore),
  });

  // Determine intent based on scores
  const scoreDifference = Math.abs(movieScore - seriesScore);
  const scoreThreshold = 2; // Minimum difference to determine a clear intent

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

async function getAIRecommendations(query, type, geminiKey, config) {
  const startTime = Date.now();
  const numResults = config?.NumResults || 10;
  const enableAiCache =
    config?.EnableAiCache !== undefined ? config.EnableAiCache : true;

  logger.debug("Starting AI recommendations", {
    query,
    type,
    requestedResults: numResults,
    cacheEnabled: enableAiCache,
  });

  const cacheKey = `${query}_${type}`;

  if (enableAiCache && aiRecommendationsCache.has(cacheKey)) {
    const cached = aiRecommendationsCache.get(cacheKey);

    logger.info("AI recommendations cache hit", {
      cacheKey,
      query,
      type,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      cachedConfigNumResults: cached.configNumResults,
      requestedResults: numResults,
      hasMovies: !!cached.data?.recommendations?.movies?.length,
      hasSeries: !!cached.data?.recommendations?.series?.length,
    });

    // Only invalidate cache if necessary
    if (cached.configNumResults && cached.configNumResults !== numResults) {
      logger.info("NumResults changed, invalidating cache", {
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
      // Return cached data with randomized order
      const randomizedData = { ...cached.data };
      if (type === "movie" && randomizedData.recommendations.movies) {
        randomizedData.recommendations.movies = shuffleArray([
          ...randomizedData.recommendations.movies,
        ]);
      } else if (type === "series" && randomizedData.recommendations.series) {
        randomizedData.recommendations.series = shuffleArray([
          ...randomizedData.recommendations.series,
        ]);
      }
      return randomizedData; // Return directly from cache
    }
  }

  if (!enableAiCache) {
    logger.info("AI cache bypassed (disabled in config)", {
      cacheKey,
      query,
      type,
    });
  } else {
    logger.info("AI recommendations cache miss", { cacheKey, query, type });
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const dateCriteria = extractDateCriteria(query);
    const genreCriteria = extractGenreCriteria(query);

    let promptText = [
      `You are a ${type} recommendation expert. Generate ${numResults} highly relevant ${type} recommendations for "${query}".`,
      "",
      "FORMAT:",
      "type|name|year|relevance",
      "",
      "RULES:",
      "1. Use | separator",
      "2. Year: YYYY format",
      `3. Type: "${type}"`,
      "4. Only best matches",
    ];

    if (dateCriteria) {
      promptText.push(
        `5. Only include ${type}s released between ${dateCriteria.startYear} and ${dateCriteria.endYear}`
      );
    }

    if (genreCriteria) {
      if (genreCriteria.include.length > 0) {
        promptText.push(
          `6. Must match genres: ${genreCriteria.include.join(", ")}`
        );
      }
      if (genreCriteria.exclude.length > 0) {
        promptText.push(
          `7. Exclude genres: ${genreCriteria.exclude.join(", ")}`
        );
      }
      if (genreCriteria.mood.length > 0) {
        promptText.push(
          `8. Match mood/style: ${genreCriteria.mood.join(", ")}`
        );
      }
    }

    promptText = promptText.join("\n");

    logger.info("Making Gemini API call", {
      model: GEMINI_MODEL,
      query,
      type,
      prompt: promptText,
      dateCriteria,
      genreCriteria,
      numResults,
    });

    const aiResult = await model.generateContent(promptText);
    const response = await aiResult.response;
    const text = response.text().trim();

    logger.info("Gemini API response", {
      duration: `${Date.now() - startTime}ms`,
      rawResponse: text,
      promptTokens: aiResult.promptFeedback?.tokenCount,
      candidates: aiResult.candidates?.length,
      safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
    });

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("type|"));

    const recommendations = {
      movies: type === "movie" ? [] : undefined,
      series: type === "series" ? [] : undefined,
    };

    for (const line of lines) {
      const [lineType, name, year, relevance] = line
        .split("|")
        .map((s) => s.trim());
      const yearNum = parseInt(year);

      if (lineType === type && name && yearNum) {
        if (dateCriteria) {
          if (
            yearNum < dateCriteria.startYear ||
            yearNum > dateCriteria.endYear
          ) {
            continue;
          }
        }

        const item = {
          name,
          year: yearNum,
          type,
          relevance,
          id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        };

        if (type === "movie") recommendations.movies.push(item);
        else if (type === "series") recommendations.series.push(item);
      }
    }

    const finalResult = {
      recommendations,
      fromCache: false,
    };

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
          duration: Date.now() - startTime,
          query,
          type,
          numResults,
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

// Add this function to shuffle array elements (Fisher-Yates algorithm)
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Add this function to fetch RPDB posters
async function fetchRpdbPoster(imdbId, rpdbKey, posterType = "poster-default") {
  if (!imdbId || !rpdbKey) {
    return null;
  }

  const cacheKey = `rpdb_${imdbId}_${posterType}`;

  // Check cache first with enhanced logging
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
    // Use the direct image URL format from the API documentation
    const url = `https://api.ratingposterdb.com/${rpdbKey}/imdb/${posterType}/${imdbId}.jpg`;

    logger.info("Making RPDB API call", {
      imdbId,
      posterType,
      url: url.replace(rpdbKey, "***"),
    });

    const response = await fetch(url);

    if (!response.ok) {
      // Cache negative results too
      rpdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: null,
      });
      return null;
    }

    // For image responses, we just need to return the URL
    // Cache the result
    rpdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: url,
    });

    logger.debug("RPDB poster result cached", {
      cacheKey,
      imdbId,
      posterType,
    });

    return url;
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

// Update the toStremioMeta function to use RPDB posters when available
async function toStremioMeta(
  item,
  platform = "unknown",
  tmdbKey,
  rpdbKey,
  rpdbPosterType = "poster-default"
) {
  if (!item.id || !item.name) {
    return null;
  }

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");

  const tmdbData = await searchTMDB(item.name, type, item.year, tmdbKey);

  if (!tmdbData || !tmdbData.imdb_id) {
    return null;
  }

  // Default poster from TMDB
  let poster = tmdbData.poster;

  // Try to get RPDB poster if API key is provided
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

  // If no poster available, return null
  if (!poster) {
    return null;
  }

  const meta = {
    id: tmdbData.imdb_id,
    type: type,
    name: item.name,
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

function sortByYear(a, b) {
  const yearA = parseInt(a.year) || 0;
  const yearB = parseInt(b.year) || 0;
  return yearB - yearA;
}

const catalogHandler = async function (args, req) {
  const startTime = Date.now();
  const { type, extra } = args;

  try {
    // Get the encrypted config data
    const encryptedConfig = req.stremioConfig;

    if (!encryptedConfig) {
      logger.error("Missing configuration - Please configure the addon first");
      return {
        metas: [],
        error: "Please configure the addon with valid API keys first",
      };
    }

    // Decrypt the config data
    const decryptedConfigStr = decryptConfig(encryptedConfig);
    if (!decryptedConfigStr) {
      logger.error("Invalid configuration - Please reconfigure the addon");
      return {
        metas: [],
        error: "Invalid configuration detected. Please reconfigure the addon.",
      };
    }

    // Parse the decrypted JSON
    const configData = JSON.parse(decryptedConfigStr);

    const geminiKey = configData.GeminiApiKey;
    const tmdbKey = configData.TmdbApiKey;

    // Add stronger validation for API keys
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

    // Use the provided key or fall back to default
    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";
    const numResults = parseInt(configData.NumResults) || 10;
    const enableAiCache =
      configData.EnableAiCache !== undefined ? configData.EnableAiCache : true;

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
    });

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

    // Determine intent from keywords
    const intent = determineIntentFromKeywords(searchQuery);

    // Only process if intent is ambiguous or matches the catalog type
    if (intent !== "ambiguous" && intent !== type) {
      logger.debug("Search intent mismatch - returning empty results", {
        intent,
        type,
        searchQuery,
        message: `This search appears to be for ${intent}, not ${type}`,
      });
      return { metas: [] };
    }

    try {
      const aiStartTime = Date.now();
      const aiResponse = await getAIRecommendations(
        searchQuery,
        type,
        geminiKey,
        configData
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

      // Get all recommendations first
      const allRecommendations =
        (type === "movie"
          ? aiResponse?.recommendations?.movies
          : aiResponse?.recommendations?.series) || [];

      // No need to sort by year here since we want randomization
      // We'll slice to the requested number
      const recommendations = allRecommendations.slice(0, numResults);

      logger.debug("Recommendations after filtering", {
        totalAvailable: allRecommendations.length,
        numResults: numResults,
        slicedCount: recommendations.length,
      });

      if (!recommendations.length) {
        logger.error("No recommendations found after filtering", {
          type,
          searchQuery,
          aiResponse,
        });
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

      const metaPromises = recommendations.map(async (item) => {
        try {
          const meta = await toStremioMeta(
            item,
            platform,
            tmdbKey,
            rpdbKey,
            rpdbPosterType
          );
          if (meta) {
            metaResults.successful++;
            return meta;
          } else {
            metaResults.failed++;
            metaResults.failures.push({
              name: item.name,
              year: item.year,
              reason: "No TMDB match",
            });
            return null;
          }
        } catch (error) {
          metaResults.failed++;
          metaResults.failures.push({
            name: item.name,
            year: item.year,
            error: error.message,
          });
          return null;
        }
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
    // Decrypt the config
    const decryptedConfigStr = decryptConfig(config);
    if (!decryptedConfigStr) {
      throw new Error("Failed to decrypt config data");
    }

    const configData = JSON.parse(decryptedConfigStr);

    const tmdbKey = configData.TmdbApiKey;
    // Use the provided key or fall back to default
    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";

    if (!tmdbKey) {
      throw new Error("Missing TMDB API key in config");
    }

    const tmdbData = await searchTMDB(id, type, null, tmdbKey);
    if (tmdbData) {
      // Try to get RPDB poster if API key is provided
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

function getCacheStats() {
  return {
    tmdbCache: {
      size: tmdbCache.size,
      maxSize: tmdbCache.max,
      usagePercentage:
        ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
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
  };
}

module.exports = {
  builder,
  addonInterface,
  catalogHandler,
  clearTmdbCache,
  clearAiCache,
  clearRpdbCache,
  getCacheStats,
};
