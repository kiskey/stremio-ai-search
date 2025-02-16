const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require('node-fetch').default;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const CACHE_DURATION = 30 * 60 * 1000;
const tmdbCache = new Map();
const aiRecommendationsCache = new Map();
const AI_CACHE_DURATION = 60 * 60 * 1000;
const JSON5 = require('json5');
const stripComments = require('strip-json-comments').default;

console.log('\n=== AI SEARCH ADDON STARTING ===');
console.log('Node version:', process.version);
console.log('Platform:', process.platform);
console.log('=================================\n');

async function searchTMDB(title, type, year) {
    const cacheKey = `${title}-${type}-${year}`;
    
    const cached = tmdbCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        logWithTime(`Using cached TMDB data for: ${title}`);
        return cached.data;
    }

    try {
        const searchType = type === 'movie' ? 'movie' : 'tv';
        const searchParams = new URLSearchParams({
            api_key: TMDB_API_KEY,
            query: title,
            year: year
        });
        
        const url = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;
        logWithTime(`Searching TMDB: ${searchType} - ${title}`);
        
        const searchResponse = await fetch(url).then(r => r.json());
        
        if (searchResponse && searchResponse.results && searchResponse.results[0]) {
            const result = searchResponse.results[0];
            
            const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
            const detailsResponse = await fetch(detailsUrl).then(r => r.json());
            
            const tmdbData = {
                poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
                backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/original${result.backdrop_path}` : null,
                tmdbRating: result.vote_average,
                genres: result.genre_ids,
                overview: result.overview || '',
                imdb_id: detailsResponse && detailsResponse.external_ids ? detailsResponse.external_ids.imdb_id : null,
                tmdb_id: result.id
            };

            tmdbCache.set(cacheKey, {
                timestamp: Date.now(),
                data: tmdbData
            });

            return tmdbData;
        }
        
        logWithTime(`No TMDB results found for: ${title}`);
        return null;
    } catch (error) {
        logError('TMDB Search Error:', error);
        return null;
    }
}

const manifest = {
    "id": "au.itcon.aisearch",
    "version": "1.0.0",
    "name": "AI Search",
    "description": "AI-powered movie and series recommendations",
    "resources": ["catalog", "meta"],
    "types": ["movie", "series"],
    "catalogs": [
        {
            type: 'movie',
            id: 'search',  // For desktop/mobile
            name: 'AI Movie Search',
            extra: [{ name: 'search', isRequired: true }],
            isSearch: true
        },
        {
            type: 'movie',
            id: 'top',     // For Android TV
            name: 'AI Movie Search',
            extra: [{ name: 'search', isRequired: true }],
            isSearch: true
        },
        {
            type: 'series',
            id: 'search',  // For desktop/mobile
            name: 'AI Series Search',
            extra: [{ name: 'search', isRequired: true }],
            isSearch: true
        },
        {
            type: 'series',
            id: 'top',     // For Android TV
            name: 'AI Series Search',
            extra: [{ name: 'search', isRequired: true }],
            isSearch: true
        }
    ],
    "behaviorHints": {
        "configurable": false,
        "searchable": true
    },
    "logo": "https://stremio.itcon.au/aisearch/logo.png",
    "background": "https://stremio.itcon.au/aisearch/bg.png",
    "contactEmail": "hi@itcon.au"
};

logWithTime('Initializing addon with manifest:', manifest);

const builder = new addonBuilder(manifest);

function logWithTime(message, data = '') {
    const timestamp = new Date().toISOString();
    const logPrefix = `[${timestamp}] 🔵`;
    
    if (data) {
        if (typeof data === 'object') {
            console.log(`${logPrefix} ${message}`, JSON.stringify(data, null, 2));
        } else {
            console.log(`${logPrefix} ${message}`, data);
        }
    } else {
        console.log(`${logPrefix} ${message}`);
    }
}

function logError(message, error = '') {
    const timestamp = new Date().toISOString();
    console.error(`\n[${timestamp}] 🔴 ${message}`, error);
    if (error && error.stack) {
        console.error(`Stack trace:`, error.stack);
    }
}

function determineIntentFromKeywords(query) {
    const q = query.toLowerCase();
    
    const movieKeywords = ['movie', 'movies', 'film', 'films', 'cinema', 'theatrical'];
    const movieMatch = movieKeywords.some(keyword => q.includes(keyword));
    
    const seriesKeywords = ['series', 'show', 'shows', 'tv', 'television', 'episode', 'episodes'];
    const seriesMatch = seriesKeywords.some(keyword => q.includes(keyword));
    
    if (movieMatch && !seriesMatch) return 'movie';
    if (seriesMatch && !movieMatch) return 'series';
    return 'ambiguous';
}

function sanitizeCSVString(str) {
    try {
        // First log the raw input
        logWithTime('Raw AI response before sanitization:', str);

        // Remove any markdown code block markers
        let cleaned = str.replace(/```csv\s*|\s*```/g, '').trim();
        
        // Parse CSV to JSON
        const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
        const recommendations = {
            movies: [],
            series: []
        };

        // Skip header row
        for (let i = 1; i < lines.length; i++) {
            const [type, name, year, description, relevance] = lines[i].split('|').map(s => s.trim());
            
            if (type && name && year) {
                const item = {
                    name,
                    year: parseInt(year),
                    type,
                    description,
                    relevance,
                    id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
                };

                if (type === 'movie') {
                    recommendations.movies.push(item);
                } else if (type === 'series') {
                    recommendations.series.push(item);
                }
            }
        }

        return JSON.stringify({ recommendations });
    } catch (error) {
        logError('CSV parsing failed:', error);
        throw error;
    }
}

async function getAIRecommendations(query) {
    const cacheKey = `${query}`;
    
    // Check cache
    const cached = aiRecommendationsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < AI_CACHE_DURATION)) {
        logWithTime(`Using cached AI recommendations for: ${query}`);
        return cached.data;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const keywordIntent = determineIntentFromKeywords(query);
        logWithTime(`Keyword-based intent check: ${keywordIntent}`);

        // Build prompt
        let promptText;
        if (keywordIntent !== 'ambiguous') {
            promptText = [
                `You are a movie and TV series recommendation expert. Generate recommendations for the search query "${query}".`,
                '',
                'RESPONSE FORMAT:',
                'type|name|year|description|relevance',
                `${keywordIntent}|Title|YYYY|Plot summary|Why this matches the query`,
                '',
                'EXAMPLE:',
                'type|name|year|description|relevance',
                'movie|The Matrix|1999|A computer programmer discovers humanity lives in a simulated reality|A groundbreaking sci-fi film about reality and control',
                '',
                'RULES:',
                '1. Use pipe (|) as separator',
                '2. No special characters or line breaks in text',
                '3. Year must be a number',
                `4. Type must be "${keywordIntent}"`,
                '5. Keep descriptions concise and factual'
            ].join('\n');
        } else {
            promptText = [
                `You are a movie and TV series recommendation expert. Analyze the search query "${query}".`,
                '',
                'RESPONSE FORMAT:',
                'type|name|year|description|relevance',
                'movie|Title|YYYY|Plot summary|Why this matches the query',
                'series|Title|YYYY|Plot summary|Why this matches the query'
            ].join('\n');
        }

        // Get AI response
        var result = await model.generateContent(promptText);
        const response = await result.response;
        const text = response.text().trim();
        
        // Parse CSV response
        const lines = text.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('type|')); // Skip header

        // Convert to recommendations object
        const recommendations = {
            movies: [],
            series: []
        };

        for (const line of lines) {
            const [type, name, year, description, relevance] = line.split('|').map(s => s.trim());
            if (type && name && year) {
                const item = {
                    name,
                    year: parseInt(year),
                    type,
                    description,
                    relevance,
                    id: `ai_${type}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
                };

                if (type === 'movie') recommendations.movies.push(item);
                else if (type === 'series') recommendations.series.push(item);
            }
        }

        // Cache results
        result = { recommendations };
        aiRecommendationsCache.set(cacheKey, {
            timestamp: Date.now(),
            data: result
        });

        return result;
    } catch (error) {
        logError("AI recommendation error:", error);
        return { recommendations: { movies: [], series: [] } };
    }
}

async function toStremioMeta(item, platform = 'unknown') {
    if (!item.id || !item.name) {
        console.warn('Invalid item:', item);
        return null;
    }

    const type = item.id.includes("movie") ? "movie" : "series";
    
    const tmdbData = await searchTMDB(item.name, type, item.year);

    if (!tmdbData || !tmdbData.poster || !tmdbData.imdb_id) {
        logWithTime(`Skipping ${item.name} - no poster image or IMDB ID available`);
        return null;
    }

    const meta = {
        id: tmdbData.imdb_id,
        type: type,
        name: item.name,
        description: platform === 'android-tv' 
            ? (tmdbData.overview || item.description || '').slice(0, 200) 
            : (tmdbData.overview || item.description || ''),
        year: parseInt(item.year) || 0,
        poster: platform === 'android-tv' 
            ? tmdbData.poster.replace('/w500/', '/w342/') 
            : tmdbData.poster,
        background: tmdbData.backdrop,
        posterShape: 'regular'
    };

    if (tmdbData.genres && tmdbData.genres.length > 0) {
        meta.genres = tmdbData.genres.map(id => TMDB_GENRES[id]).filter(Boolean);
    }

    return meta;
}

// Pre-warm cache for common queries
async function warmupCache(query) {
    try {
        const aiResponse = await getAIRecommendations(query);
        if (aiResponse) {
            logWithTime(`Cache warmed up for: ${query}`);
        }
    } catch (error) {
        // Ignore warmup errors
    }
}

function detectPlatform(extra = {}) {
    // First check the stremio-platform header that we set in the server
    if (extra.headers?.['stremio-platform']) {
        return extra.headers['stremio-platform'];
    }

    const userAgent = (extra.userAgent || extra.headers?.['stremio-user-agent'] || '').toLowerCase();
    
    // Check for Android TV
    if (userAgent.includes('android tv') ||
        userAgent.includes('chromecast') ||
        userAgent.includes('androidtv')) {
        return 'android-tv';
    }
    
    // Check for mobile
    if (userAgent.includes('android') || 
        userAgent.includes('mobile') || 
        userAgent.includes('phone')) {
        return 'mobile';
    }
    
    // Check for desktop
    if (userAgent.includes('windows') || 
        userAgent.includes('macintosh') || 
        userAgent.includes('linux')) {
        return 'desktop';
    }
    
    return 'unknown';
}

builder.defineCatalogHandler(async function(args) {
    const { type, id, extra } = args;

    // Enhanced platform detection
    const platform = detectPlatform(extra);
    
    logWithTime('CATALOG HANDLER CALLED:', {
        type,
        id,
        platform,
        userAgent: extra?.userAgent || extra?.headers?.['stremio-user-agent'],
        platformHeader: extra?.headers?.['stremio-platform'],
        rawHeaders: extra?.headers,
        hasSearch: !!extra?.search,
        searchQuery: extra?.search,
        extraKeys: Object.keys(extra || {})
    });

    // Extract search query from various possible locations
    const searchQuery = extra?.search || 
                       (extra?.extra && decodeURIComponent(extra.extra)) ||
                       (typeof extra === 'string' && decodeURIComponent(extra));

    // Log the search request details
    logWithTime('Search request analysis:', {
        originalQuery: extra?.search,
        decodedExtra: extra?.extra ? decodeURIComponent(extra.extra) : null,
        finalSearchQuery: searchQuery,
        catalogId: id,
        type: type,
        platform
    });

    // Handle empty or invalid search
    if (!searchQuery) {
        logWithTime('No search query found in request');
        return { metas: [] };
    }

    try {
        const aiResponse = await getAIRecommendations(searchQuery);
        
        // Get recommendations based on type and availability
        let recommendations = [];
        if (type === 'movie') {
            recommendations = aiResponse.recommendations.movies || [];
        } else if (type === 'series') {
            // If searching in series but only got movies, use movies instead
            if (aiResponse.recommendations.series?.length === 0 && aiResponse.recommendations.movies?.length > 0) {
                recommendations = aiResponse.recommendations.movies || [];
            } else {
                recommendations = aiResponse.recommendations.series || [];
            }
        }

        logWithTime(`Got ${recommendations.length} recommendations for "${searchQuery}"`, {
            type,
            catalogId: id,
            platform,
            hasMovies: (aiResponse.recommendations.movies || []).length > 0,
            hasSeries: (aiResponse.recommendations.series || []).length > 0
        });

        // Convert to Stremio meta objects with proper platform info
        const metas = [];
        for (const item of recommendations) {
            const meta = await toStremioMeta(item, platform);
            if (meta) {
                // Ensure proper poster size for Android TV
                if (platform === 'android-tv' && meta.poster) {
                    meta.poster = meta.poster.replace('/w500/', '/w342/');
                    // Ensure description is not too long for TV
                    meta.description = meta.description?.slice(0, 200);
                }
                metas.push(meta);
            }
        }

        logWithTime(`Returning ${metas.length} results for search: ${searchQuery}`, {
            platform,
            firstPoster: metas[0]?.poster,
            firstTitle: metas[0]?.name
        });

        return { metas };
    } catch (error) {
        logError('Search processing error:', error);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async function(args) {
    const { type, id } = args;

    logWithTime('Meta handler called with args:', args);

    if (id.startsWith('ai_')) {
        try {
            const [_, itemType, itemNumber, ...titleParts] = id.split('_');
            const title = titleParts.join('_');
            
            const meta = await toStremioMeta({
                id: id,
                name: title.replace(/_/g, ' '),
                type: itemType
            });
            
            if (meta) {
                logWithTime('Returning meta for id:', id);
                return { meta };
            }
        } catch (error) {
            logError("Meta Error:", error);
        }
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
    37: "Western"
};

const addonInterface = builder.getInterface();
console.log('\n=== ADDON INTERFACE CREATED ===');
console.log('Resources:', addonInterface.manifest.resources);
console.log('Types:', addonInterface.manifest.types);
console.log('Catalogs:', addonInterface.manifest.catalogs.length);
console.log('=============================\n');

module.exports = addonInterface; 
