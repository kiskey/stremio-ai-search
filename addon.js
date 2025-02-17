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
const TMDB_BATCH_SIZE = 15;
const TMDB_CONCURRENT_LIMIT = 3;
const sharp = require('sharp');
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const OMDB_API_BASE = 'http://www.omdbapi.com';
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
        
        const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;
        const searchResponse = await fetch(searchUrl).then(r => r.json());
        
        if (searchResponse?.results?.[0]) {
            const result = searchResponse.results[0];
            
            const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${TMDB_API_KEY}&append_to_response=external_ids,credits,similar`;
            
            const detailsPromise = fetch(detailsUrl).then(r => r.json());
            
            const tmdbData = {
                poster: result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : null,
                backdrop: result.backdrop_path ? `https://image.tmdb.org/t/p/original${result.backdrop_path}` : null,
                tmdbRating: result.vote_average,
                genres: result.genre_ids,
                overview: result.overview || '',
                tmdb_id: result.id
            };

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
    
    const movieKeywords = [
        'movie', 'movies', 'film', 'films', 'cinema', 'theatrical',
        'feature', 'features', 'motion picture', 'blockbuster',
        'documentary', 'documentaries'
    ];
    
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
        logWithTime('Raw AI response before sanitization:', str);

        let cleaned = str.replace(/```csv\s*|\s*```/g, '').trim();
        
        const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
        const recommendations = {
            movies: [],
            series: []
        };

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
    
    const cached = aiRecommendationsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < AI_CACHE_DURATION)) {
        logWithTime(`Using cached AI recommendations for: ${query} (${type})`);
        return cached.data;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        
        const promptText = [
            `You are a movie and TV series recommendation expert. Generate at least 10 ${type} recommendations for "${query}". More the better but your mantra should be quality over quantity.`,
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

        var result = await model.generateContent(promptText);
        const response = await result.response;
        const text = response.text().trim();
        
        const lines = text.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('type|')); // Skip header

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
    if (!OMDB_API_KEY || !imdbId) return null;
    
    const cacheKey = `imdb_${imdbId}`;
    const cached = imdbCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        logWithTime(`Using cached IMDb rating for: ${imdbId}`);
        return cached.data;
    }

    try {
        const url = `${OMDB_API_BASE}/?i=${imdbId}&apikey=${OMDB_API_KEY}`;
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
        logError('IMDb Rating Error:', error);
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

    let posterUrl = tmdbData.poster;
    const imdbRating = await fetchIMDBRating(tmdbData.imdb_id);
    
    if (imdbRating) {
        try {
            posterUrl = await addRatingToImage(tmdbData.poster, imdbRating.imdb.toFixed(1));
        } catch (error) {
            logError('Error modifying poster:', error);
        }
    }

    const meta = {
        id: tmdbData.imdb_id,
        type: type,
        name: item.name,
        description: platform === 'android-tv' 
            ? (tmdbData.overview || item.description || '').slice(0, 200) 
            : (tmdbData.overview || item.description || ''),
        year: parseInt(item.year) || 0,
        poster: posterUrl,
        background: tmdbData.backdrop,
        posterShape: 'regular'
    };

    if (tmdbData.genres && tmdbData.genres.length > 0) {
        meta.genres = tmdbData.genres.map(id => TMDB_GENRES[id]).filter(Boolean);
    }

    return meta;
}

async function addRatingToImage(imageUrl, rating) {
    try {
        const imageResponse = await fetch(imageUrl);
        const imageBuffer = await imageResponse.arrayBuffer();

        const image = sharp(Buffer.from(imageBuffer));
        const metadata = await image.metadata();
        
        const blackBarHeight = Math.floor(metadata.height / 12);
        const imdbLogoSize = Math.floor(blackBarHeight * 0.8);
        const fullWidth = metadata.width;
        
        const imdbLogoSvg = `<?xml version="1.0" ?><!DOCTYPE svg  PUBLIC '-//W3C//DTD SVG 1.1//EN'  'http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd'><svg height="512px" style="enable-background:new 0 0 512 512;" version="1.1" viewBox="0 0 512 512" width="512px" xml:space="preserve" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g id="_x31_71-imdb"><g><g><g><path d="M436.714,26.001H75.287c-27.21,0-49.285,22.075-49.285,49.286v361.427      c0,27.211,22.075,49.285,49.285,49.285h361.427c27.211,0,49.284-22.074,49.284-49.285V75.287      C485.998,48.076,463.925,26.001,436.714,26.001z" style="fill:#FBBF14;"/></g></g><rect height="131.222" style="fill:#273238;" width="33.883" x="91.716" y="190.287"/><path d="M241.831,321.509h-29.469v-88.714l-11.912,88.714H179.3l-12.528-86.763v86.763h-29.776V190.287    h43.947c3.39,20.329,6.16,40.968,8.934,61.504l7.803-61.504h44.152V321.509z" style="fill:#273238;"/><path d="M330.544,236.8c0-8.317,0.31-17.25-1.438-25.055c-4.414-23.102-32.24-21.458-50.311-21.458h-25.261    v131.222C341.942,321.612,330.544,327.669,330.544,236.8z M287.522,298.713v-85.94c12.219,0,10.576,6.47,10.576,16.428v50.622    C298.099,289.781,300.049,299.022,287.522,298.713z" style="fill:#273238;"/><path d="M395.949,223.656c-9.137,0-15.298,2.773-21.457,9.447v-42.816h-32.55v131.222h30.597l1.953-8.317    c5.852,6.982,12.218,10.063,21.457,10.063c20.331,0,22.795-15.607,22.795-31.729v-36.963    C418.744,236.8,417.923,223.656,395.949,223.656z M379.522,304.362c-1.642,0-3.081-0.823-3.902-2.465    c-2.26-5.237-1.128-45.281-1.128-45.897c0-3.901-1.132-13.04,5.03-13.04c7.496,0,6.364,7.496,6.364,13.04v33.574    C385.887,295.12,387.53,304.362,379.522,304.362z" style="fill:#273238;"/></g></g></svg>`;
        
        const ratingFontSize = Math.floor(imdbLogoSize * 0.7);
        const spaceBetween = Math.floor(imdbLogoSize * 0.4);
        const totalContentWidth = imdbLogoSize + spaceBetween + (rating.length + 3) * (ratingFontSize * 0.6);
        
        const contentStartX = (fullWidth - totalContentWidth) / 2;
        const verticalCenter = blackBarHeight / 2;
        
        const svg = `
        <svg width="${metadata.width}" height="${metadata.height}">
            <g transform="translate(0, ${metadata.height - blackBarHeight})">
                <!-- Full black background -->
                <rect x="0" y="0" 
                      width="${fullWidth}" height="${blackBarHeight}" 
                      fill="black" opacity="0.7"/>
                
                <!-- Centered content -->
                <g transform="translate(${contentStartX}, 0)">
                    <!-- IMDb logo -->
                    <image x="0" y="${(blackBarHeight - imdbLogoSize) / 2}" 
                           width="${imdbLogoSize}" height="${imdbLogoSize}" 
                           href="data:image/svg+xml;base64,${Buffer.from(imdbLogoSvg).toString('base64')}" 
                           preserveAspectRatio="xMidYMid meet"/>
                    
                    <!-- Rating text -->
                    <text x="${imdbLogoSize + spaceBetween}" 
                          y="${verticalCenter}"
                          font-family="Arial" 
                          font-size="${ratingFontSize}" 
                          font-weight="bold" 
                          fill="white" 
                          text-anchor="start" 
                          dominant-baseline="middle">
                        ${rating}/10
                    </text>
                </g>
            </g>
        </svg>`;

        const modifiedImageBuffer = await image
            .composite([{
                input: Buffer.from(svg),
                top: 0,
                left: 0
            }])
            .jpeg()
            .toBuffer();

        return `data:image/jpeg;base64,${modifiedImageBuffer.toString('base64')}`;
    } catch (error) {
        console.error('Error adding rating to image:', error);
        return imageUrl;
    }
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

        // Use the new batch processing
        const metas = await batchProcessTMDB(recommendations, platform);

        // Platform-specific adjustments
        if (platform === 'android-tv') {
            metas.forEach(meta => {
                if (meta.poster) {
                    meta.poster = meta.poster.replace('/w500/', '/w342/');
                }
                if (meta.description) {
                    meta.description = meta.description.slice(0, 200);
                }
            });
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
