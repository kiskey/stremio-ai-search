const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require('node-fetch').default;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const OMDB_API_BASE = 'http://www.omdbapi.com';
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes
const AI_CACHE_DURATION = 60 * 60 * 1000; // 1 hour
const TMDB_BATCH_SIZE = 15;
const TMDB_CONCURRENT_LIMIT = 3;
const BATCH_SIZE = 5; // Process 5 items at a time
const BATCH_DELAY = 100; // 100ms delay between batches

// Optimized caches using Map
const tmdbCache = new Map();
const aiRecommendationsCache = new Map();
const imdbCache = new Map();

// Simplified manifest
const manifest = {
    "id": "au.itcon.aisearch",
    "version": "1.0.0",
    "name": "AI Search",
    "description": "AI-powered movie and series recommendations",
    "resources": ["catalog"],
    "types": ["movie", "series"],
    "catalogs": [
        {
            type: 'movie',
            id: 'search',
            name: 'AI Movie Search',
            extra: [{ name: 'search', isRequired: true }],
            isSearch: true
        },
        {
            type: 'series',
            id: 'search',
            name: 'AI Series Search',
            extra: [{ name: 'search', isRequired: true }],
            isSearch: true
        }
    ],
    "behaviorHints": {
        "configurable": false,
        "searchable": true
    }
};

const builder = new addonBuilder(manifest);

// Add this utility function for batching
async function processBatch(items, processFn, batchSize = BATCH_SIZE) {
    const results = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(processFn)
        );
        results.push(...batchResults);
        
        if (i + batchSize < items.length) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
    }
    
    return results;
}

// Optimized TMDB search with parallel requests
async function searchTMDB(title, type, year) {
    const cacheKey = `${title}-${type}-${year}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached?.timestamp > Date.now() - CACHE_DURATION) return cached.data;

    try {
        const searchType = type === 'movie' ? 'movie' : 'tv';
        const searchParams = new URLSearchParams({
            api_key: TMDB_API_KEY,
            query: title,
            year
        }).toString();

        const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams}`;
        const [searchResponse] = await Promise.all([
            fetch(searchUrl).then(r => r.json())
        ]);

        if (!searchResponse?.results?.[0]) return null;

        const result = searchResponse.results[0];
        const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
        const [detailsResponse] = await Promise.all([
            fetch(detailsUrl).then(r => r.json())
        ]);

        const tmdbData = {
            poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
            backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/original${result.backdrop_path}` : null,
            overview: result.overview || '',
            imdb_id: detailsResponse?.external_ids?.imdb_id
        };

        tmdbCache.set(cacheKey, { timestamp: Date.now(), data: tmdbData });
        return tmdbData;
    } catch {
        return null;
    }
}

// Optimized OMDB rating fetch
async function fetchIMDBRating(imdbId, expectedTitle) {
    if (!OMDB_API_KEY || !imdbId) return null;
    
    const cacheKey = `imdb_${imdbId}`;
    const cached = imdbCache.get(cacheKey);
    if (cached?.timestamp > Date.now() - CACHE_DURATION) return cached.data;

    try {
        const url = `${OMDB_API_BASE}/?i=${imdbId}&apikey=${OMDB_API_KEY}`;
        const data = await fetch(url).then(r => r.json());
        
        if (data.Response === 'True' && expectedTitle) {
            const titleMatch = data.Title.toLowerCase().includes(expectedTitle.toLowerCase()) ||
                             expectedTitle.toLowerCase().includes(data.Title.toLowerCase());
            if (!titleMatch) return null;
        }

        if (data.Response === 'True' && data.imdbRating && data.imdbRating !== 'N/A') {
            const rating = {
                imdb: parseFloat(data.imdbRating),
                votes: parseInt(data.imdbVotes?.replace(/,/g, '') || '0')
            };
            
            imdbCache.set(cacheKey, { timestamp: Date.now(), data: rating });
            return rating;
        }
        return null;
    } catch {
        return null;
    }
}

// Optimized meta conversion
async function toStremioMeta(item, platform) {
    if (!item.id || !item.name) return null;

    const type = item.id.includes("movie") ? "movie" : "series";
    const tmdbData = await searchTMDB(item.name, type, item.year);
    if (!tmdbData?.poster || !tmdbData.imdb_id) return null;

    const imdbRating = await fetchIMDBRating(tmdbData.imdb_id, item.name);
    const posterUrl = platform === 'android-tv' 
        ? tmdbData.poster.replace('/w500/', '/w342/') 
        : tmdbData.poster;

    return {
        id: tmdbData.imdb_id,
        type,
        name: item.name,
        description: platform === 'android-tv' 
            ? tmdbData.overview.slice(0, 200) 
            : tmdbData.overview,
        year: parseInt(item.year) || 0,
        poster: imdbRating ? await addRatingToImage(posterUrl, imdbRating.imdb.toFixed(1)) : posterUrl,
        background: tmdbData.backdrop,
        posterShape: 'regular'
    };
}

// Update the catalog handler
builder.defineCatalogHandler(async ({ type, extra }) => {
    const platform = extra?.headers?.['stremio-platform'] || 'desktop';
    const searchQuery = extra?.search || '';
    if (!searchQuery) return { metas: [] };

    try {
        const aiResponse = await getAIRecommendations(searchQuery, type);
        const recommendations = type === 'movie' 
            ? aiResponse.recommendations.movies || []
            : aiResponse.recommendations.series || [];

        if (!recommendations.length) return { metas: [] };

        // First, batch process TMDB searches
        const tmdbResults = await searchTMDBBatch(
            recommendations.map(item => ({
                title: item.name,
                type,
                year: item.year
            }))
        );

        // Filter valid TMDB results and prepare for OMDB
        const validTmdbResults = tmdbResults
            .filter(result => result.data?.imdb_id && result.data?.poster)
            .map((result, index) => ({
                tmdbData: result.data,
                originalItem: recommendations[index]
            }));

        // Batch process OMDB ratings
        const imdbRatings = await fetchIMDBRatingsBatch(
            validTmdbResults.map(item => ({
                imdbId: item.tmdbData.imdb_id,
                title: item.originalItem.name
            }))
        );

        // Create final metas
        const metas = validTmdbResults.map((item, index) => {
            const rating = imdbRatings[index]?.data;
            const posterUrl = platform === 'android-tv' 
                ? item.tmdbData.poster.replace('/w500/', '/w342/') 
                : item.tmdbData.poster;

            return {
                id: item.tmdbData.imdb_id,
                type,
                name: item.originalItem.name,
                description: platform === 'android-tv' 
                    ? item.tmdbData.overview.slice(0, 200) 
                    : item.tmdbData.overview,
                year: parseInt(item.originalItem.year) || 0,
                poster: rating ? addRatingToImage(posterUrl, rating.imdb.toFixed(1)) : posterUrl,
                background: item.tmdbData.backdrop,
                posterShape: 'regular'
            };
        });

        return { metas: metas.filter(Boolean) };
    } catch {
        return { metas: [] };
    }
});

// Update TMDB search to handle batches of requests
async function searchTMDBBatch(items) {
    return processBatch(items, async ({ title, type, year }) => {
        const cacheKey = `${title}-${type}-${year}`;
        const cached = tmdbCache.get(cacheKey);
        if (cached?.timestamp > Date.now() - CACHE_DURATION) {
            return { cacheKey, data: cached.data };
        }

        try {
            const searchType = type === 'movie' ? 'movie' : 'tv';
            const searchParams = new URLSearchParams({
                api_key: TMDB_API_KEY,
                query: title,
                year
            }).toString();

            const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams}`;
            const [searchResponse] = await Promise.all([
                fetch(searchUrl).then(r => r.json())
            ]);

            if (!searchResponse?.results?.[0]) return { cacheKey, data: null };

            const result = searchResponse.results[0];
            const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
            const [detailsResponse] = await Promise.all([
                fetch(detailsUrl).then(r => r.json())
            ]);

            const tmdbData = {
                poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
                backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/original${result.backdrop_path}` : null,
                overview: result.overview || '',
                imdb_id: detailsResponse?.external_ids?.imdb_id
            };

            tmdbCache.set(cacheKey, { timestamp: Date.now(), data: tmdbData });
            return { cacheKey, data: tmdbData };
        } catch {
            return { cacheKey, data: null };
        }
    });
}

// Update OMDB rating fetch to handle batches
async function fetchIMDBRatingsBatch(items) {
    return processBatch(items, async ({ imdbId, title }) => {
        const cacheKey = `imdb_${imdbId}`;
        const cached = imdbCache.get(cacheKey);
        if (cached?.timestamp > Date.now() - CACHE_DURATION) {
            return { cacheKey, data: cached.data };
        }

        try {
            const url = `${OMDB_API_BASE}/?i=${imdbId}&apikey=${OMDB_API_KEY}`;
            const data = await fetch(url).then(r => r.json());
            
            if (data.Response === 'True' && title) {
                const titleMatch = data.Title.toLowerCase().includes(title.toLowerCase()) ||
                                 title.toLowerCase().includes(data.Title.toLowerCase());
                if (!titleMatch) return { cacheKey, data: null };
            }

            if (data.Response === 'True' && data.imdbRating && data.imdbRating !== 'N/A') {
                const rating = {
                    imdb: parseFloat(data.imdbRating),
                    votes: parseInt(data.imdbVotes?.replace(/,/g, '') || '0')
                };
                
                imdbCache.set(cacheKey, { timestamp: Date.now(), data: rating });
                return { cacheKey, data: rating };
            }
            return { cacheKey, data: null };
        } catch {
            return { cacheKey, data: null };
        }
    });
}

// Add this after the caches
async function getAIRecommendations(query, type) {
    const cacheKey = `ai_${query}_${type}`;
    const cached = aiRecommendationsCache.get(cacheKey);
    if (cached?.timestamp > Date.now() - AI_CACHE_DURATION) {
        return cached.data;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const prompt = `Generate movie/series recommendations based on this search: "${query}"
            Format as JSON with this structure for ${type === 'movie' ? 'movies' : 'series'}:
            {
                "recommendations": {
                    "${type}s": [
                        {
                            "id": "${type}_title_year",
                            "name": "Title",
                            "year": "Year"
                        }
                    ]
                }
            }
            Include 5-10 relevant ${type}s. Use real titles and years.`;

        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        
        // Extract JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        
        const recommendations = JSON.parse(jsonMatch[0]);
        
        aiRecommendationsCache.set(cacheKey, {
            timestamp: Date.now(),
            data: recommendations
        });

        return recommendations;
    } catch {
        return {
            recommendations: {
                [`${type}s`]: []
            }
        };
    }
}

module.exports = builder.getInterface(); 
