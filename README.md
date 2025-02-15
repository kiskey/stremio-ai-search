# Stremio AI Search Addon

An AI-powered movie and TV series recommendation addon for Stremio that uses Google's Gemini AI to provide intelligent search results.

## Features

- AI-powered search for movies and TV series
- Intelligent intent detection to determine if user is searching for movies, series, or both
- Rich metadata integration with TMDB
- Caching system to improve performance
- Detailed search results with plot summaries and relevance explanations

## Prerequisites

- Node.js >= 16.0.0
- A Google Gemini API key (get it from [Google AI Studio](https://makersuite.google.com/app/apikey))
- A TMDB API key (get it from [TMDB](https://www.themoviedb.org/settings/api))

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/stremio-ai-search.git
   cd stremio-ai-search
   ```
   
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with your API keys:
   ```bash
   GEMINI_API_KEY=your_gemini_api_key_here
   TMDB_API_KEY=your_tmdb_api_key_here
   PORT=7000
   HOST=localhost 
   ```

4. Start the server:
   ```bash
   npm start
   ```
The addon will be available at `http://localhost:7000`. You can add it to Stremio by clicking on the addon icon and entering:
`http://localhost:7000/manifest.json`

### Production Deployment

For production deployment using PM2:

1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```

2. Start the server with PM2:
   ```bash
   pm2 start ecosystem.config.js
   ```

3. Check the status of the server:
   ```bash
   pm2 status
   ```

4. To ensure PM2 restarts on system reboot:
   ```bash
   pm2 startup
   pm2 save
   ```

## Usage

1. Open Stremio and go to the addon library.
2. Search for movies or TV series using natural language queries.
3. The addon will use AI to determine the user's intent and provide intelligent search results.

## How It Works

1. When a user searches in Stremio, the addon analyzes the query using Google's Gemini AI
2. The AI determines whether the user is looking for movies, TV series, or both
3. Based on the analysis, it generates relevant recommendations
4. The addon then fetches additional metadata from TMDB
5. Results are returned to Stremio with posters, descriptions, and other metadata

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- [Google Gemini AI](https://deepmind.google/technologies/gemini/)
- [TMDB API](https://developers.themoviedb.org/3)

## Support

If you encounter any issues or have questions, please open an issue on GitHub.
