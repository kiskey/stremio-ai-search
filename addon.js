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

function sanitizeJSONString(str) {
    try {
        // Remove any markdown code block markers
        str = str.replace(/```json\s*|\s*```/g, '').trim();
        
        // Fix line breaks and extra spaces
        str = str.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        
        // Fix trailing commas
        str = str.replace(/,(\s*[}\]])/g, '$1');
        
        // Fix unquoted property names
        str = str.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
        
        // Fix single quotes to double quotes
        str = str.replace(/'/g, '"');
        
        // Remove any control characters
        str = str.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

        return str;
    } catch (error) {
        logError('Error sanitizing JSON string:', error);
        return str;
    }
}

async function getAIRecommendations(query) {
    const cacheKey = `${query}`;
    
    const cached = aiRecommendationsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < AI_CACHE_DURATION)) {
        logWithTime(`Using cached AI recommendations for: ${query}`);
        return cached.data;
    }

    const keywordIntent = determineIntentFromKeywords(query);
    logWithTime(`Keyword-based intent check: ${keywordIntent}`);

    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const prompt = keywordIntent !== 'ambiguous' 
        ? `You are a movie and TV series recommendation expert. Generate recommendations for the search query "${query}".

TASK:
Generate ${keywordIntent === 'movie' ? 'movie' : 'series'} recommendations that are highly relevant to the query.

RESPONSE FORMAT:
Return a valid JSON object with this exact structure:
{
    "recommendations": {
        "${keywordIntent}s": [
            {
                "name": "Title",
                "year": YYYY,
                "type": "${keywordIntent}",
                "description": "Brief plot summary without any quotes or special characters",
                "relevance": "Why this matches the query - avoid using quotes or special characters"
            }
        ]
    }
}

IMPORTANT FORMATTING RULES:
1. DO NOT use any quotation marks (single or double) within description or relevance text
2. DO NOT use any special characters like ``, ', ", \, or /
3. Use simple periods, commas, and dashes for punctuation
4. Keep descriptions concise and free of any nested quotes
5. If you need to mention speech or quotes, use phrases like: the character says, or they claim that

CONTENT RULES:
1. Recommendation Quality:
   - Include only HIGHLY RELEVANT recommendations
   - Each must have clear thematic/stylistic connection to query
   - Aim for 10-20 recommendations
   - Prioritize quality over quantity

2. Content Selection:
   - Focus on critically acclaimed and well-received titles
   - Include both classic and contemporary options
   - Ensure diverse representation in recommendations
   - Avoid obscure or poorly received titles

3. Description Format:
   - Keep descriptions factual and concise
   - Avoid subjective opinions
   - Do not include quotes from reviews or dialogue
   - Focus on plot and themes without spoilers`

        : `You are a movie and TV series recommendation expert. Analyze the search query "${query}".

TASK:
1. Determine if the query is more relevant for movies, series, or both
2. Generate relevant recommendations accordingly

RESPONSE FORMAT:
Return a valid JSON object with this exact structure:
{
    "intent": "movie" | "series" | "ambiguous",
    "explanation": "Brief explanation of intent detection",
    "recommendations": {
        "movies": [...],
        "series": [...]
    }
}

RULES:
1. TOKEN EFFICIENCY:
   - For clear movie/series intent, return ONLY that content type
   - Do not waste tokens on irrelevant content type
   - Skip the unused array entirely (don't return empty array)

2. Recommendation Quality:
   - Include only HIGHLY RELEVANT recommendations
   - Each must have clear thematic/stylistic connection to query
   - Aim for 10-20 recommendations for requested type(s)
   - Prioritize quality over quantity

3. Content Selection:
   - Focus on critically acclaimed and well-received titles
   - Consider themes, tone, style, and subject matter
   - For specific queries (actor/director/genre), include their best works

4. Technical:
   - Valid years in YYYY format
   - Concise descriptions
   - Proper JSON formatting
   - No markdown or extra text

EXAMPLES:
Query: "movies about time travel" 
→ Intent: "movie" (contains "movies")
→ Return only movie recommendations

Query: "breaking bad like shows"
→ Intent: "series" (contains "shows")
→ Return only series recommendations

Query: "psychological thrillers"
→ Intent: "ambiguous" (no specific indicator)
→ Return both types

Remember: Be strict with intent detection to optimize token usage. Return ONLY the JSON object.`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text().trim();
        
        logWithTime('Raw AI response:', text);
        let cleanedText = sanitizeJSONString(text);
        logWithTime('Cleaned text:', cleanedText);

        let aiResponse;
        try {
            aiResponse = JSON.parse(cleanedText);
        } catch (initialParseError) {
            logError('Initial parse failed, attempting to fix JSON:', initialParseError);
            
            try {
                // Try using JSON5 for more lenient parsing
                const JSON5 = require('json5');
                aiResponse = JSON5.parse(cleanedText);
            } catch (json5Error) {
                // If still fails, try one last cleanup
                cleanedText = cleanedText
                    .replace(/\s+/g, ' ')  // Normalize whitespace
                    .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')  // Quote unquoted keys
                    .replace(/:\s*'([^']*)'/g, ':"$1"')  // Replace single quotes with double quotes
                    .replace(/,\s*}/g, '}')  // Remove trailing commas
                    .replace(/,\s*,/g, ',')  // Remove double commas
                    .replace(/\\/g, '\\\\');  // Escape backslashes

                try {
                    aiResponse = JSON.parse(cleanedText);
                } catch (finalError) {
                    logError('Failed to parse response after all attempts. Raw text:', cleanedText);
                    throw new Error('Failed to parse AI response');
                }
            }
        }

        // Ensure we have the expected structure
        if (!aiResponse.recommendations) {
            aiResponse = { recommendations: { } };
        }

        // Normalize the response structure
        const processedResponse = {
            recommendations: {
                movies: (aiResponse.recommendations.movies || []).map(item => ({
                    name: item.title || item.name,
                    year: item.year,
                    type: 'movie',
                    description: item.description,
                    relevance: item.relevance,
                    id: `ai_movie_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
                })),
                series: (aiResponse.recommendations.series || []).map(item => ({
                    name: item.title || item.name,
                    year: item.year,
                    type: 'series',
                    description: item.description,
                    relevance: item.relevance,
                    id: `ai_series_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
                }))
            }
        };

        // Cache the processed response
        aiRecommendationsCache.set(cacheKey, {
            timestamp: Date.now(),
            data: processedResponse
        });

        return processedResponse;
    } catch (error) {
        logError("AI or parsing error:", error);
        return { 
            recommendations: {
                movies: [],
                series: []
            }
        };
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

builder.defineCatalogHandler(async function(args) {
    const { type, id, extra } = args;

    // Detect platform from various sources
    const platform = extra?.platform || 
                    extra?.headers?.['stremio-platform'] || 
                    (extra?.userAgent?.toLowerCase().includes('android tv') ? 'android-tv' : 'unknown');

    logWithTime('CATALOG HANDLER CALLED:', {
        type,
        id,
        platform,
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
        
        // Get recommendations based on type
        const recommendations = type === 'movie' 
            ? aiResponse.recommendations.movies || []
            : aiResponse.recommendations.series || [];

        logWithTime(`Got ${recommendations.length} recommendations for "${searchQuery}"`, {
            type,
            catalogId: id,
            platform
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
