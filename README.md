<div align="center">💗 <a href="https://buymeacoffee.com/itcon">If you found this useful, please consider buying me a coffee</a> 💗<br/><br/></div>

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

## Security Considerations

### API Keys
- Never commit your `.env` file to GitHub
- Keep your API keys private and secure
- The `.env.example` file shows required variables without actual keys

### Data Privacy
This addon:
- Does not store user data
- Does not track searches permanently
- Only caches results temporarily for performance
- Makes API calls to TMDB and Google Gemini AI services

## Detailed Server Setup Guide

### 1. Server Prerequisites
```bash
# Install Node.js and npm (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# If using Apache as reverse proxy, install required modules
a2enmod headers
a2enmod proxy
a2enmod proxy_http
a2enmod ssl
a2enmod rewrite
```

### 2. Project Setup
```bash
# Create project directory
mkdir -p /home/yourusername/public_html/stremio
cd /home/yourusername/public_html/stremio

# Clone the repository
git clone https://github.com/itcon-pty-au/stremio-ai-search.git .

# Install dependencies
npm install
```

### 3. Apache Virtual Host Configuration
Create a new Apache configuration file:
```apache
# /etc/apache2/sites-available/stremio.yourdomain.com.conf
<VirtualHost *:443>
    ServerName stremio.yourdomain.com
    DocumentRoot /home/yourusername/public_html/stremio

    SSLEngine on
    SSLCertificateFile /path/to/cert.pem
    SSLCertificateKeyFile /path/to/key.pem

    ProxyPreserveHost On
    ProxyPass / http://localhost:7000/
    ProxyPassReverse / http://localhost:7000/

    ErrorLog ${APACHE_LOG_DIR}/stremio_error.log
    CustomLog ${APACHE_LOG_DIR}/stremio_access.log combined
</VirtualHost>
```

Enable the site:
```bash
a2ensite stremio.yourdomain.com
systemctl restart apache2
```

### 4. Firewall Configuration
```bash
# Allow port 7000
iptables -A INPUT -p tcp --dport 7000 -j ACCEPT
iptables -A OUTPUT -p tcp --sport 7000 -j ACCEPT

# Save iptables rules
iptables-save > /etc/iptables/rules.v4
```

### 5. Process Management
```bash
# Start the addon
pm2 start ecosystem.config.js

# Save PM2 process list
pm2 save

# Enable PM2 startup script
pm2 startup
```

### 6. Verification Steps
```bash
# Check if Node.js server is running
curl http://localhost:7000/manifest.json

# Check if proxy is working
curl https://stremio.yourdomain.com/manifest.json

# Check PM2 status
pm2 list

# Check Apache status
systemctl status apache2
```

### 7. Maintenance Commands
```bash
# View logs
pm2 logs stremio-aisearch

# Monitor processes
pm2 monit

# Restart after changes
pm2 stop all
pm2 delete all
sudo lsof -t -i:7000 | xargs kill -9
pm2 start ecosystem.config.js
```

### 8. Troubleshooting

If port 7000 is in use:
```bash
lsof -i :7000
kill -9 $(lsof -t -i:7000)
```

If Apache fails to start:
```bash
apache2ctl -t
systemctl status apache2
```

Check Node.js server:
```bash
netstat -tulpn | grep :7000
```

Check logs:
```bash
pm2 logs stremio-aisearch
tail -f /var/log/apache2/error.log
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- [Google Gemini AI](https://deepmind.google/technologies/gemini/)
- [TMDB API](https://developers.themoviedb.org/3)

## About me
I am a passionate developer dedicated to creating useful tools that can benefit the community. My goal is to distribute all of my projects as open source, enabling others to learn, contribute, and innovate together. If you appreciate my work and want to support my efforts, feel free to [buy me a coffee](https://buymeacoffee.com/itcon) :heart:!

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please open an issue on GitHub.