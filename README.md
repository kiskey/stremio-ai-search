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
   HOST=0.0.0.0  # Allow external connections
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

## Running the Addon

### Local Development
```bash
npm start
```
The addon will be available at `http://localhost:7000`. 

### Server Deployment

1. If you're hosting on a server, update your `.env` file with your server details:
```bash
GEMINI_API_KEY=your_gemini_api_key_here
TMDB_API_KEY=your_tmdb_api_key_here
PORT=7000
HOST=0.0.0.0  # Allow external connections
```

2. Configure your firewall to allow traffic on the specified port (7000 by default)

3. The addon will be accessible at:
- Local network: `http://YOUR_SERVER_IP:7000/manifest.json`
- Public domain: `http://YOUR_DOMAIN:7000/manifest.json`
  
4. For production, it's recommended to:
   - Set up a reverse proxy (like Nginx) to handle HTTPS
   - Use a domain name with SSL certificate
   - Your manifest URL would then be: `https://YOUR_DOMAIN/manifest.json`

Example Nginx configuration:
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Adding to Stremio

1. Open Stremio
2. Click on the addon icon (puzzle piece)
3. Click "Enter addon URL"
4. Enter your manifest URL:
   - Local development: `http://localhost:7000/manifest.json`
   - Server (HTTP): `http://YOUR_DOMAIN:7000/manifest.json`
   - Server (HTTPS): `https://YOUR_DOMAIN/manifest.json`

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

## Security Considerations

### API Keys
- Never commit your `.env` file to GitHub
- Keep your API keys private and secure
- Regularly rotate your API keys if possible
- The `.env.example` file shows required variables without actual keys

### Self Hosting
For privacy and security reasons, this addon should be self-hosted. When you host it:
- Use HTTPS in production
- Set appropriate rate limits
- Consider implementing additional security measures like API key rotation
- Monitor your API usage to prevent abuse

### Data Privacy
This addon:
- Does not store user data
- Does not track searches permanently
- Only caches results temporarily for performance
- Makes API calls to TMDB and Google Gemini AI services
