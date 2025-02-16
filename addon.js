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
    "name": "AI Movie & Series Search",
    "description": "Get AI-powered movie and series recommendations",
    "resources": ["catalog", "meta", "stream"],
    "types": ["movie", "series"],
    "catalogs": [
        {
            type: 'movie',
            id: 'movie-recommendations',
            name: 'Search',
            extra: [
                { 
                    name: 'search',
                    isRequired: true,
                    options: { searchDebounce: 1000 }
                }
            ]
        },
        {
            type: 'series',
            id: 'series-recommendations', 
            name: 'Search',
            extra: [
                { 
                    name: 'search',
                    isRequired: true,
                    options: { searchDebounce: 1000 }
                }
            ]
        }
    ],
    "idPrefixes": [ "ai_", "tt" ]
};

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
        str = str.replace(/```json\s*|\s*```/g, '').trim();
        
        str = str.replace(/,(\s*[}\]])/g, '$1');
        
        str = str.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
        
        str = str.replace(/"(true|false)"/g, '$1');
        
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
                "description": "2-3 sentence plot summary",
                "relevance": "Why this matches the query"
            }
        ]
    }
}

RULES:
1. Recommendation Quality:
   - Include only HIGHLY RELEVANT recommendations
   - Each must have clear thematic/stylistic connection to query
   - Aim for 10-20 recommendations
   - Prioritize quality over quantity

2. Content Selection:
   - Focus on critically acclaimed and well-received titles
   - Consider themes, tone, style, and subject matter
   - For specific queries (actor/director/genre), include their best works

3. Technical:
   - Valid years in YYYY format
   - Concise descriptions
   - Proper JSON formatting
   - No markdown or extra text

Remember: Return ONLY the JSON object.`

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
        const text = response.text().trim();
        
        logWithTime('Raw AI Response:', text);
        const cleanedText = sanitizeJSONString(text);
        logWithTime('Sanitized Response:', cleanedText);

        try {
            let aiResponse;
            try {
                aiResponse = JSON.parse(cleanedText);
            } catch (initialParseError) {
                logError('Initial parse failed, attempting to fix JSON:', initialParseError);
                const JSON5 = require('json5');
                try {
                    aiResponse = JSON5.parse(cleanedText);
                } catch (json5Error) {
                    throw new Error(`Failed to parse response: ${initialParseError.message}`);
                }
            }

            const processedResponse = {
                intent: keywordIntent !== 'ambiguous' ? keywordIntent : (aiResponse.intent || 'ambiguous'),
                explanation: keywordIntent !== 'ambiguous' 
                    ? `Intent determined by keyword match in query: "${query}"`
                    : (aiResponse.explanation || 'Intent determined by AI analysis'),
                recommendations: {
                    ...(keywordIntent === 'movie' || keywordIntent === 'ambiguous' 
                        ? { movies: aiResponse.recommendations?.movies || [] }
                        : {}),
                    ...(keywordIntent === 'series' || keywordIntent === 'ambiguous'
                        ? { series: aiResponse.recommendations?.series || [] }
                        : {})
                }
            };

            if (processedResponse.recommendations.movies) {
                processedResponse.recommendations.movies = processedResponse.recommendations.movies.map((item, index) => ({
                    ...item,
                    id: `ai_movie_${index + 1}_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
                }));
            }
            if (processedResponse.recommendations.series) {
                processedResponse.recommendations.series = processedResponse.recommendations.series.map((item, index) => ({
                    ...item,
                    id: `ai_series_${index + 1}_${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`                }));
            }

            logWithTime('Successfully parsed AI response');
            
            aiRecommendationsCache.set(cacheKey, {
                timestamp: Date.now(),
                data: processedResponse
            });
            
            return processedResponse;
        } catch (parseError) {
            throw parseError;
        }
    } catch (error) {
        logError("AI or parsing error:", error);
        return { 
            intent: keywordIntent,
            explanation: 'Error getting recommendations, using keyword-based intent',
            recommendations: { 
                ...(keywordIntent === 'movie' || keywordIntent === 'ambiguous' ? { movies: [] } : {}),
                ...(keywordIntent === 'series' || keywordIntent === 'ambiguous' ? { series: [] } : {})
            }
        };
    }
}

async function toStremioMeta(item) {
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
        description: tmdbData.overview || item.description || '',
        year: parseInt(item.year) || 0,
        poster: tmdbData.poster,
        background: tmdbData.backdrop,
        posterShape: 'regular'
    };

    if (tmdbData.genres && tmdbData.genres.length > 0) {
        meta.genres = tmdbData.genres.map(id => TMDB_GENRES[id]).filter(Boolean);
    }

    return meta;
}

builder.defineCatalogHandler(async function(args) {
    const { type, id, extra } = args;
    
    if (!GEMINI_API_KEY || !TMDB_API_KEY) {
        logError('Missing API keys - GEMINI_API_KEY:', !!GEMINI_API_KEY, 'TMDB_API_KEY:', !!TMDB_API_KEY);
        return { metas: [] };
    }

    logWithTime('Catalog handler called with args:', {
        type,
        id,
        extra,
        platform: extra && extra.platform || 'unknown',
        userAgent: extra && extra.userAgent || 'unknown'
    });

    if (!extra || !extra.search) {
        logWithTime('No search query provided');
        return { metas: [] };
    }

    const requestedType = type;
    const query = extra.search;

    try {
        logWithTime(`Processing search request for "${query}" (${requestedType})`);
        
        const aiResponse = await getAIRecommendations(query);
        logWithTime(`AI Response received:`, {
            intent: aiResponse.intent,
            explanation: aiResponse.explanation,
            moviesCount: (aiResponse.recommendations.movies && aiResponse.recommendations.movies.length) || 0,
            seriesCount: (aiResponse.recommendations.series && aiResponse.recommendations.series.length) || 0
        });

        if (aiResponse.intent !== 'ambiguous' && requestedType !== aiResponse.intent) {
            logWithTime(`Skipping ${requestedType} catalog due to ${aiResponse.intent} intent`);
            return { metas: [] };
        }

        const recommendationsToProcess = requestedType === 'movie' 
            ? aiResponse.recommendations.movies 
            : aiResponse.recommendations.series;

        if (!recommendationsToProcess || recommendationsToProcess.length === 0) {
            logWithTime(`No ${requestedType} recommendations found`);
            return { metas: [] };
        }

        const processBatch = async (batch) => {
            return Promise.all(batch.map(item => toStremioMeta(item)));
        };

        const batchSize = 5;
        const batches = [];
        for (let i = 0; i < recommendationsToProcess.length; i += batchSize) {
            batches.push(recommendationsToProcess.slice(i, i + batchSize));
        }

        const results = [];
        for (const batch of batches) {
            const batchResults = await processBatch(batch);
            results.push(...batchResults);
        }

        const validMetas = results.filter(meta => meta !== null);
        
        logWithTime('Returning metas to Stremio:', validMetas);
        return { metas: validMetas };
    } catch (error) {
        logError("Catalog Error:", error);
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

builder.defineStreamHandler(function(args) {
    logWithTime('Stream handler called with args:', args);
    
    return Promise.resolve({ streams: [] });
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
module.exports = builder.getInterface(); 
