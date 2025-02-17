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
const TMDB_BATCH_SIZE = 15; // Process 5 items at a time
const TMDB_CONCURRENT_LIMIT = 3; // Maximum concurrent TMDB API requests
const IMDB_API_BASE = 'https://www.omdbapi.com';
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const imdbCache = new Map();

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
        
        // Fetch search and details in parallel if possible
        const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;
        const searchResponse = await fetch(searchUrl).then(r => r.json());
        
        if (searchResponse?.results?.[0]) {
            const result = searchResponse.results[0];
            
            // Construct details URL but don't fetch yet
            const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids,credits,similar`;
            
            // Fetch details in parallel with any other processing
            const detailsPromise = fetch(detailsUrl).then(r => r.json());
            
            // Construct basic data while details are being fetched
            const tmdbData = {
                poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
                backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/original${result.backdrop_path}` : null,
                tmdbRating: result.vote_average,
                genres: result.genre_ids,
                overview: result.overview || '',
                tmdb_id: result.id
            };

            // Wait for details and add additional data
            const detailsResponse = await detailsPromise;
            if (detailsResponse?.external_ids) {
                tmdbData.imdb_id = detailsResponse.external_ids.imdb_id;
                tmdbData.cast = detailsResponse.credits?.cast?.slice(0, 5) || [];
                tmdbData.similar = detailsResponse.similar?.results?.slice(0, 3) || [];
            }

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
    
    // Expanded movie-related keywords
    const movieKeywords = [
        'movie', 'movies', 'film', 'films', 'cinema', 'theatrical',
        'feature', 'features', 'motion picture', 'blockbuster',
        'documentary', 'documentaries'
    ];
    
    // Expanded series-related keywords
    const seriesKeywords = [
        'series', 'show', 'shows', 'tv', 'television', 'episode', 'episodes',
        'sitcom', 'drama series', 'miniseries', 'season', 'seasons',
        'anime', 'documentary series', 'docuseries', 'web series'
    ];
    
    const movieMatch = movieKeywords.some(keyword => q.includes(keyword));
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

async function getAIRecommendations(query, type) {
    const cacheKey = `${query}_${type}`;
    
    // Check cache
    const cached = aiRecommendationsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < AI_CACHE_DURATION)) {
        logWithTime(`Using cached AI recommendations for: ${query} (${type})`);
        return cached.data;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        
        // Build prompt based on type
        const promptText = [
            `You are a movie and TV series recommendation expert. Generate ${type} recommendations for "${query}".`,
            '',
            'RESPONSE FORMAT:',
            'type|name|year|description|relevance',
            `${type}|Title|YYYY|Plot summary|Why this matches the query`,
            '',
            'EXAMPLE:',
            'type|name|year|description|relevance',
            type === 'movie' ?
                'movie|The Matrix|1999|A computer programmer discovers humanity lives in a simulated reality|A groundbreaking sci-fi film about reality and control' :
                'series|Breaking Bad|2008|A high school chemistry teacher turns to a life of crime|A critically acclaimed series about moral decay',
            '',
            'RULES:',
            '1. Use pipe (|) as separator',
            '2. No special characters or line breaks in text',
            '3. Year must be a number',
            `4. Type must be "${type}"`,
            '5. Keep descriptions concise and factual'
        ].join('\n');

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
            movies: type === 'movie' ? [] : undefined,
            series: type === 'series' ? [] : undefined
        };

        for (const line of lines) {
            const [lineType, name, year, description, relevance] = line.split('|').map(s => s.trim());
            if (lineType === type && name && year) {
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
        return { 
            recommendations: {
                movies: type === 'movie' ? [] : undefined,
                series: type === 'series' ? [] : undefined
            }
        };
    }
}

async function fetchIMDBRating(imdbId) {
    if (!OMDB_API_KEY) return null;
    
    const cacheKey = `imdb_${imdbId}`;
    const cached = imdbCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        return cached.data;
    }

    try {
        const url = `${IMDB_API_BASE}/?i=${imdbId}&apikey=${OMDB_API_KEY}`;
        const response = await fetch(url).then(r => r.json());
        
        if (response.imdbRating && response.imdbRating !== 'N/A') {
            const rating = {
                imdb: parseFloat(response.imdbRating),
                votes: parseInt(response.imdbVotes.replace(/,/g, '')) || 0
            };
            
            imdbCache.set(cacheKey, {
                timestamp: Date.now(),
                data: rating
            });
            
            return rating;
        }
        return null;
    } catch (error) {
        logError('IMDB Rating Error:', error);
        return null;
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
        posterShape: 'regular',
        tmdbRating: tmdbData.tmdbRating,
        behaviorHints: {
            hasMetaUpdate: true
        }
    };

    if (tmdbData.genres && tmdbData.genres.length > 0) {
        meta.genres = tmdbData.genres.map(id => TMDB_GENRES[id]).filter(Boolean);
    }

    return meta;
}

// Pre-warm cache for common queries
async function warmupCache(query) {
    try {
        const aiResponse = await getAIRecommendations(query, 'movie');
        if (aiResponse) {
            logWithTime(`Cache warmed up for: ${query} (movie)`);
        }
    } catch (error) {
        // Ignore warmup errors
    }

    try {
        const aiResponse = await getAIRecommendations(query, 'series');
        if (aiResponse) {
            logWithTime(`Cache warmed up for: ${query} (series)`);
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

async function batchProcessTMDB(items, platform) {
    const results = [];
    
    // Process items in batches
    for (let i = 0; i < items.length; i += TMDB_BATCH_SIZE) {
        const batch = items.slice(i, i + TMDB_BATCH_SIZE);
        
        // Process batch items in parallel with concurrency limit
        const batchPromises = batch.map(item => {
            return new Promise(async (resolve) => {
                try {
                    const meta = await toStremioMeta(item, platform);
                    resolve(meta);
                } catch (error) {
                    logError(`TMDB batch processing error for ${item.name}:`, error);
                    resolve(null);
                }
            });
        });

        // Wait for all items in this batch
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(Boolean));
        
        // Add a small delay between batches to avoid rate limiting
        if (i + TMDB_BATCH_SIZE < items.length) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    return results;
}

function generateIMDbBadge(rating) {
    // Skip if no rating
    if (!rating) return null;
    
    // Round to one decimal place
    const score = parseFloat(rating.imdb).toFixed(1);
    
    // Create SVG with IMDb styling
    const svg = `
    <svg width="64" height="24" xmlns="http://www.w3.org/2000/svg">
        <rect width="64" height="24" fill="#000000"/>
        <rect x="0" y="0" width="64" height="24" fill="#F5C518"/>
        <rect x="0" y="0" width="24" height="24" fill="#000000"/>
        <text x="12" y="17" font-family="Arial Black" font-size="14" fill="#F5C518" text-anchor="middle">IMDb</text>
        <text x="44" y="17" font-family="Arial" font-size="14" font-weight="bold" fill="#000000" text-anchor="middle">${score}</text>
    </svg>`;
    
    // Convert to data URL
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    return dataUrl;
}

builder.defineCatalogHandler(async function(args) {
    const { type, id, extra } = args;
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
        // Check the intent of the search query
        const intent = determineIntentFromKeywords(searchQuery);
        
        // If the intent doesn't match the requested type and isn't ambiguous, return empty results
        if (intent !== 'ambiguous' && intent !== type) {
            logWithTime(`Search intent (${intent}) doesn't match requested type (${type}), returning empty results`);
            return { metas: [] };
        }

        // Continue with existing AI recommendations logic
        const aiResponse = await getAIRecommendations(searchQuery, type);
        
        // Get recommendations for the specific type only
        const recommendations = type === 'movie' 
            ? aiResponse.recommendations.movies || []
            : aiResponse.recommendations.series || [];

        logWithTime(`Got ${recommendations.length} ${type} recommendations for "${searchQuery}"`, {
            type,
            catalogId: id,
            platform
        });

        // First pass: Get basic meta info with posters quickly
        const quickMetas = await batchProcessTMDB(recommendations, platform);
        
        // Send the initial response with posters
        const response = { metas: quickMetas };
        
        // Second pass: Fetch ratings in the background
        Promise.all(quickMetas.map(async (meta) => {
            if (meta.id) {
                try {
                    const imdbRating = await fetchIMDBRating(meta.id);
                    if (imdbRating) {
                        // Use IMDb badge instead of combined rating
                        meta.logo = generateIMDbBadge(imdbRating);
                        meta.behaviorHints = {
                            ...meta.behaviorHints,
                            hasMetaUpdate: true
                        };
                    }
                } catch (error) {
                    // Silently fail for background updates
                    logError(`Rating fetch error for ${meta.id}:`, error);
                }
            }
        })).then(() => {
            // Meta updates will be picked up by Stremio automatically
            logWithTime('Background ratings update completed');
        });

        return response;
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
