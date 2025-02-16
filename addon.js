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

function sanitizeJSONString(str) {
    try {
        // First log the raw input
        logWithTime('Raw AI response before sanitization:', str);

        // Remove any markdown code block markers
        let cleaned = str.replace(/```json\s*|\s*```/g, '').trim();
        
        // Remove any control characters
        cleaned = cleaned.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

        logWithTime('Cleaned text before parsing:', cleaned);

        // Try parsing with JSON5 first (more lenient)
        try {
            const parsed = JSON5.parse(cleaned);
            logWithTime('Successfully parsed with JSON5');
            return JSON.stringify(parsed); // Convert back to standard JSON
        } catch (json5Error) {
            logWithTime('JSON5 parsing failed, trying standard JSON:', json5Error);
            // If JSON5 fails, try standard JSON
            const parsed = JSON.parse(cleaned);
            return JSON.stringify(parsed);
        }
    } catch (error) {
        logError('All JSON parsing attempts failed:', error);
        logError('Final cleaned text that failed:', cleaned);
        throw error;
    }
}

async function getAIRecommendations(query) {
    const cacheKey = `${query}`;
    
    const cached = aiRecommendationsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < AI_CACHE_DURATION)) {
        logWithTime(`Using cached AI recommendations for: ${query}`);
        return cached.data;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const keywordIntent = determineIntentFromKeywords(query);
        logWithTime(`Keyword-based intent check: ${keywordIntent}`);

        let promptText;
        if (keywordIntent !== 'ambiguous') {
            promptText = [
                `You are a movie and TV series recommendation expert. Generate recommendations for the search query "${query}". Based on the query, you will generate a list of recommendations for movies or series in a parseable JSON format.`,
                'RESPONSE FORMAT:',
                'Return a valid JSON object with this EXACT structure:',
                '{',
                '    "recommendations": {',
                `        "${keywordIntent}s": [`,
                '            {',
                '                "name": "Title Here",',
                '                "year": 1999,',
                `                "type": "${keywordIntent}",`,
                '                "description": "Plot summary here - no quotes, new lines, or apostrophes in text",',
                '                "relevance": "Relevance explanation here - no quotes, new lines, or apostrophes in text"',
                '            }',
                '        ]',
                '    }',
                '}',
                '',
                'EXAMPLE RESPONSE:',
                '{',
                '    "recommendations": {',
                '        "movies": [',
                '            {',
                '                "name": "The Matrix",',
                '                "year": 1999,',
                '                "type": "movie",',
                '                "description": "A computer programmer discovers humanity lives in a simulated reality and joins a rebellion to free mankind",',
                '                "relevance": "A groundbreaking sci-fi film that revolutionized special effects and storytelling"',
                '            }',
                '        ]',
                '    }',
                '}',
                '',
                'CRITICAL JSON RULES:',
                '1. Property names must use double quotes: "name", "year", etc.',
                '2. Property values must use double quotes: "value here"',
                '3. Numbers and booleans should not use any quotes: "year": 1999',
                '',
                'CONTENT RULES:',
                '1. Recommendation Quality:',
                '   - Include only HIGHLY RELEVANT recommendations',
                '   - Each must have clear thematic/stylistic connection to query',
                '   - Aim for 10-20 recommendations',
                '   - Prioritize quality over quantity',
                '',
                '2. Content Selection:',
                '   - Focus on critically acclaimed and well-received titles',
                '   - Include both classic and contemporary options',
                '   - Ensure diverse representation in recommendations',
                '   - Avoid obscure or poorly received titles',
                '',
                '3. Description Format:',
                '   - Keep descriptions factual and concise',
                '   - Avoid subjective opinions',
                '   - Never include quoted speech or dialogue',
                '   - Focus on plot and themes without spoilers',
                '   - Use simple language and basic punctuation',
                '   - Use periods, commas, and dashes only',
                ''
            ].join('\n');
        } else {
            promptText = [
                `You are a movie and TV series recommendation expert. Analyze the search query "${query}".`,
                '',
                'TASK:',
                '1. Determine if the query is more relevant for movies, series, or both',
                '2. Generate relevant recommendations accordingly',
                '',
                'RESPONSE FORMAT:',
                'Return a valid JSON object with this exact structure:',
                '{',
                '    "intent": "movie" | "series" | "ambiguous",',
                '    "explanation": "Brief explanation of intent detection",',
                '    "recommendations": {',
                '        "movies": [...],',
                '        "series": [...]',
                '    }',
                '}',
                '',
                'IMPORTANT FORMATTING RULES:',
                '1. DO NOT use any quotation marks in text fields in the JSON',
                '2. DO NOT use any special characters like `, \', ", \\, or / in the text fields in the JSON',
                '3. Use simple periods, commas, and dashes for punctuation',
                '4. Keep all text fields free of any quotes or special characters',
                '5. Use plain text only - no formatting, no special symbols',
                '',
                'CONTENT RULES:',
                '1. TOKEN EFFICIENCY:',
                '   - For clear movie/series intent, return ONLY that content type',
                '   - Do not waste tokens on irrelevant content type',
                '   - Skip the unused array entirely (do not return empty array)',
                '',
                '2. Recommendation Quality:',
                '   - Include only HIGHLY RELEVANT recommendations',
                '   - Each must have clear thematic/stylistic connection to query',
                '   - Aim for 10-20 recommendations for requested type(s)',
                '   - Prioritize quality over quantity',
                '',
                '3. Content Selection:',
                '   - Focus on critically acclaimed and well-received titles',
                '   - Consider themes, tone, style, and subject matter',
                '   - For specific queries (actor/director/genre), include their best works',
                '',
                '4. Description Format:',
                '   - Keep descriptions factual and concise',
                '   - Avoid subjective opinions',
                '   - Do not include quotes from reviews or dialogue',
                '   - Use simple language and basic punctuation',
                '',
                'Remember: Return ONLY parseable JSON object with clean, quote-free text in all fields.'
            ].join('\n');
        }

        const result = await model.generateContent(promptText);
        const response = await result.response;
        let text = response.text().trim();
        
        // Sanitize and parse the response
        const sanitizedJson = sanitizeJSONString(text);
        const aiResponse = JSON.parse(sanitizedJson);

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

        logWithTime('Parsed AI Response:', aiResponse);
        logWithTime('Processed Response:', processedResponse);

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
