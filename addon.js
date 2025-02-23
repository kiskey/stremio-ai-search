const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch").default;
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const CACHE_DURATION = 30 * 60 * 1000;
const tmdbCache = new Map();
const aiRecommendationsCache = new Map();
const AI_CACHE_DURATION = 60 * 60 * 1000;
const GEMINI_MODEL = "gemini-2.0-flash";


async function searchTMDB(title, type, year, tmdbKey) {
  const cacheKey = `${title}-${type}-${year}`;

  const cached = tmdbCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }

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
    const searchResponse = await fetch(searchUrl).then((r) => r.json());

    if (searchResponse?.results?.[0]) {
      const result = searchResponse.results[0];

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
        const details = await fetch(detailsUrl).then((r) => r.json());
        if (details?.external_ids?.imdb_id) {
          tmdbData.imdb_id = details.external_ids.imdb_id;
        }
      }

      tmdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: tmdbData,
      });

      return tmdbData;
    }

    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });

    return null;
  } catch (error) {
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
    configurable: false,
    searchable: true,
  },
  logo: "https://stremio.itcon.au/aisearch/logo.png",
  background: "https://stremio.itcon.au/aisearch/bg.png",
  contactEmail: "hi@itcon.au",
};

const builder = new addonBuilder(manifest);

function determineIntentFromKeywords(query) {
  const q = query.toLowerCase();

  const movieKeywords = [
    "movie",
    "movies",
    "film",
    "films",
    "cinema",
    "theatrical",
    "feature",
    "features",
    "motion picture",
    "blockbuster",
    "documentary",
    "documentaries",
  ];

  const seriesKeywords = [
    "series",
    "show",
    "shows",
    "tv",
    "television",
    "episode",
    "episodes",
    "sitcom",
    "drama series",
    "miniseries",
    "season",
    "seasons",
    "anime",
    "documentary series",
    "docuseries",
    "web series",
  ];

  const movieMatch = movieKeywords.some((keyword) => q.includes(keyword));
  const seriesMatch = seriesKeywords.some((keyword) => q.includes(keyword));

  if (movieMatch && !seriesMatch) return "movie";
  if (seriesMatch && !movieMatch) return "series";
  return "ambiguous";
}

function extractDateCriteria(query) {
  const currentYear = new Date().getFullYear()
  const q = query.toLowerCase()

  const patterns = {
    inYear: /(?:in|from|of)\s+(\d{4})/i,
    between: /between\s+(\d{4})\s+and\s+(\d{4}|today)/i,
    lastNYears: /last\s+(\d+)\s+years?/i,
    released: /released\s+in\s+(\d{4})/i,
    decade: /(?:in |from )?(?:the\s+)?(\d{2})(?:'?s|0s)|(\d{4})s/i,
    decadeWord: /(?:in |from )?(?:the\s+)?(sixties|seventies|eighties|nineties)/i,
    relative: /(?:newer|more recent|older) than (?:the year )?(\d{4})/i,
    modern: /modern|recent|latest|new/i,
    classic: /classic|vintage|old|retro/i,
    prePost: /(?:pre|post)-(\d{4})/i
  }

  const decadeMap = {
    sixties: 1960,
    seventies: 1970,
    eighties: 1980,
    nineties: 1990
  }

  for (const [type, pattern] of Object.entries(patterns)) {
    const match = q.match(pattern)
    if (match) {
      switch (type) {
        case 'inYear':
          return { startYear: parseInt(match[1]), endYear: parseInt(match[1]) }

        case 'between':
          const endYear = match[2].toLowerCase() === 'today' ? currentYear : parseInt(match[2])
          return { startYear: parseInt(match[1]), endYear }

        case 'lastNYears':
          return { startYear: currentYear - parseInt(match[1]), endYear: currentYear }

        case 'released':
          return { startYear: parseInt(match[1]), endYear: parseInt(match[1]) }

        case 'decade': {
          let decade
          if (match[1]) {
            decade = match[1].length === 2 ? (match[1] > '20' ? 1900 : 2000) + parseInt(match[1]) : parseInt(match[1])
          } else {
            decade = parseInt(match[2])
          }
          return { startYear: decade, endYear: decade + 9 }
        }

        case 'decadeWord': {
          const decade = decadeMap[match[1]]
          return decade ? { startYear: decade, endYear: decade + 9 } : null
        }

        case 'relative':
          const year = parseInt(match[1])
          return q.includes('newer') || q.includes('more recent') 
            ? { startYear: year, endYear: currentYear }
            : { startYear: 1900, endYear: year }

        case 'modern':
          return { startYear: currentYear - 10, endYear: currentYear }

        case 'classic':
          return { startYear: 1900, endYear: 1980 }

        case 'prePost':
          const pivotYear = parseInt(match[1])
          return q.startsWith('pre') 
            ? { startYear: 1900, endYear: pivotYear - 1 }
            : { startYear: pivotYear + 1, endYear: currentYear }
      }
    }
  }
  return null
}

function extractGenreCriteria(query) {
  const q = query.toLowerCase()
  
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
    animation: /\b(animation|animated|anime)\b/i
  }

  const subGenres = {
    cyberpunk: /\b(cyberpunk|cyber\s*punk)\b/i,
    noir: /\b(noir|neo-noir)\b/i,
    psychological: /\b(psychological)\b/i,
    superhero: /\b(superhero|comic\s*book|marvel|dc)\b/i,
    musical: /\b(musical|music)\b/i,
    war: /\b(war|military)\b/i,
    western: /\b(western|cowboy)\b/i,
    sports: /\b(sports?|athletic)\b/i
  }

  const moods = {
    feelGood: /\b(feel-?good|uplifting|heartwarming)\b/i,
    dark: /\b(dark|gritty|disturbing)\b/i,
    thoughtProvoking: /\b(thought-?provoking|philosophical|deep)\b/i,
    intense: /\b(intense|gripping|edge.*seat)\b/i,
    lighthearted: /\b(light-?hearted|fun|cheerful)\b/i
  }

  const combinedPattern = /(?:action[- ]comedy|romantic[- ]comedy|sci-?fi[- ]horror|dark[- ]comedy|romantic[- ]thriller)/i

  const notPattern = /\b(?:not|no|except)\b\s+(\w+)/i

  const genres = {
    include: [],
    exclude: [],
    mood: [],
    style: []
  }

  const combinedMatch = q.match(combinedPattern)
  if (combinedMatch) {
    genres.include.push(combinedMatch[0].toLowerCase().replace(/\s+/g, '-'))
  }

  const notMatches = q.match(new RegExp(notPattern, 'g'))
  if (notMatches) {
    notMatches.forEach(match => {
      const excluded = match.match(notPattern)[1]
      genres.exclude.push(excluded.toLowerCase())
    })
  }

  for (const [genre, pattern] of Object.entries(basicGenres)) {
    if (pattern.test(q) && !genres.exclude.includes(genre)) {
      genres.include.push(genre)
    }
  }

  for (const [subgenre, pattern] of Object.entries(subGenres)) {
    if (pattern.test(q) && !genres.exclude.includes(subgenre)) {
      genres.include.push(subgenre)
    }
  }

  for (const [mood, pattern] of Object.entries(moods)) {
    if (pattern.test(q)) {
      genres.mood.push(mood)
    }
  }

  return Object.values(genres).some(arr => arr.length > 0) ? genres : null
}

async function getAIRecommendations(query, type, apiKey) {
  const cacheKey = `${query}-${type}`;
  const cached = aiRecommendationsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < AI_CACHE_DURATION) {
    return cached.data;
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const dateCriteria = extractDateCriteria(query)
    const genreCriteria = extractGenreCriteria(query)
    
    let promptText = [
      `You are a ${type} recommendation expert. Generate 10 highly relevant ${type} recommendations for "${query}".`,
      "",
      "FORMAT:",
      "type|name|year|description|relevance",
      "",
      "RULES:",
      "1. Use | separator",
      "2. Year: YYYY format",
      `3. Type: "${type}"`,
      "4. Brief descriptions",
      "5. Only best matches"
    ]

    if (dateCriteria) {
      promptText.push(`6. Only include ${type}s released between ${dateCriteria.startYear} and ${dateCriteria.endYear}`)
    }

    if (genreCriteria) {
      if (genreCriteria.include.length > 0) {
        promptText.push(`7. Must match genres: ${genreCriteria.include.join(', ')}`)
      }
      if (genreCriteria.exclude.length > 0) {
        promptText.push(`8. Exclude genres: ${genreCriteria.exclude.join(', ')}`)
      }
      if (genreCriteria.mood.length > 0) {
        promptText.push(`9. Match mood/style: ${genreCriteria.mood.join(', ')}`)
      }
    }

    promptText = promptText.join("\n")

    var result = await model.generateContent(promptText)
    const response = await result.response
    const text = response.text().trim()

    const lines = text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("type|"))

    const recommendations = {
      movies: type === "movie" ? [] : undefined,
      series: type === "series" ? [] : undefined
    }

    for (const line of lines) {
      const [lineType, name, year, description, relevance] = line.split("|").map(s => s.trim())
      const yearNum = parseInt(year)

      if (lineType === type && name && yearNum) {
        if (dateCriteria) {
          if (yearNum < dateCriteria.startYear || yearNum > dateCriteria.endYear) {
            continue
          }
        }

        const item = {
          name,
          year: yearNum,
          type,
          description,
          relevance,
          id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
        }

        if (type === "movie") recommendations.movies.push(item)
        else if (type === "series") recommendations.series.push(item)
      }
    }

    result = { recommendations }
    aiRecommendationsCache.set(cacheKey, {
      timestamp: Date.now(),
      data: result
    })

    return result
  } catch (error) {
    logError("AI recommendation error:", error)
    return {
      recommendations: {
        movies: type === "movie" ? [] : undefined,
        series: type === "series" ? [] : undefined
      }
    }
  }
}

async function toStremioMeta(item, platform = "unknown", tmdbKey) {
  if (!item.id || !item.name) {
    console.warn("Invalid item:", item);
    return null;
  }

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");

  const tmdbData = await searchTMDB(item.name, type, item.year, tmdbKey);

  if (!tmdbData || !tmdbData.poster || !tmdbData.imdb_id) {
    return null;
  }

  const meta = {
    id: tmdbData.imdb_id,
    type: type,
    name: item.name,
    description:
      platform === "android-tv"
        ? (tmdbData.overview || item.description || "").slice(0, 200)
        : tmdbData.overview || item.description || "",
    year: parseInt(item.year) || 0,
    poster:
      platform === "android-tv"
        ? tmdbData.poster.replace("/w500/", "/w342/")
        : tmdbData.poster,
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
    const { type, extra } = args;
    
    try {
        const configData = req.stremioConfig;
        if (!configData) {
            return { metas: [] };
        }

        const geminiKey = configData.GeminiApiKey;
        const tmdbKey = configData.TmdbApiKey;

        if (!geminiKey || !tmdbKey) {
            return { metas: [] };
        }

        const platform = detectPlatform(extra);
        
        let searchQuery = '';
        if (typeof extra === 'string' && extra.includes('search=')) {
            searchQuery = decodeURIComponent(extra.split('search=')[1]);
        } else if (extra?.search) {
            searchQuery = extra.search;
        }

        if (!searchQuery) {
            return { metas: [] };
        }

        const intent = determineIntentFromKeywords(searchQuery);
        if (intent !== "ambiguous" && intent !== type) {
            return { metas: [] };
        }

        try {
            const aiResponse = await getAIRecommendations(searchQuery, type, geminiKey);

            const recommendations =
                (type === "movie"
                    ? aiResponse.recommendations.movies
                    : aiResponse.recommendations.series)
                    ?.sort(sortByYear)
                    .slice(0, 10) || [];

            const metaPromises = recommendations.map((item) =>
                toStremioMeta(item, platform, tmdbKey)
            );
            const metas = (await Promise.all(metaPromises)).filter(Boolean);

            return { metas };
        } catch (error) {
            return { metas: [] };
        }
    } catch (error) {
        return { metas: [] };
    }
};

builder.defineCatalogHandler(catalogHandler);
builder.defineMetaHandler(async function (args) {
  const { type, id, config } = args;
  logWithTime("Meta handler called with args:", args);

  try {
    const configData = JSON.parse(decodeURIComponent(config));
    const tmdbKey = configData.TmdbApiKey;

    if (!tmdbKey) {
      throw new Error("Missing TMDB API key in config");
    }

    const tmdbData = await searchTMDB(id, type, null, tmdbKey);
    if (tmdbData) {
      const meta = {
        id: tmdbData.imdb_id,
        type: type,
        name: tmdbData.title || tmdbData.name,
        description: tmdbData.overview,
        year: parseInt(tmdbData.release_date || tmdbData.first_air_date) || 0,
        poster: tmdbData.poster,
        background: tmdbData.backdrop,
        posterShape: "regular",
      };

      if (tmdbData.genres) {
        meta.genres = tmdbData.genres
          .map((id) => TMDB_GENRES[id])
          .filter(Boolean);
      }

      return { meta };
    }
  } catch (error) {
    logError("Meta Error:", error);
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
module.exports = { builder, addonInterface, catalogHandler };