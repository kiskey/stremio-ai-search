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
   git clone https://github.com/itcon-pty-au/stremio-ai-search.git
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

The addon will be available at `http://localhost:7000`. You can add it to Stremio by clicking on the addon icon and entering:
`http://localhost:7000/manifest.json`

### Production Deployment

For production deployment, we'll use PM2 with systemd integration for automatic startup:

1. Install PM2 globally:
```bash
npm install -g pm2
```

2. Start the server with PM2:
```bash
pm2 start ecosystem.config.js
```

3. Generate startup script and save PM2 process list:
```bash
# Generate startup script (this will create a systemd service for PM2)
sudo pm2 startup systemd

# Save current process list
pm2 save
```

4. Verify the setup:
```bash
# Check PM2 status
pm2 status

# Check logs
pm2 logs stremio-ai-addon

# Test automatic startup by rebooting
sudo reboot
```

### Maintenance Commands

```bash
# View logs
pm2 logs stremio-ai-addon

# Monitor processes
pm2 monit

# Restart the addon
pm2 restart stremio-ai-addon

# Update after code changes
git pull
pm2 reload stremio-ai-addon

# Clean restart
pm2 stop all
pm2 delete all
pm2 start ecosystem.config.js
```

### Log Management

PM2 automatically handles log rotation, but you can also set up system-level log rotation:

```bash
sudo nano /etc/logrotate.d/stremio-addon
```

Add the following content:
```
/path/to/your/stremio/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 644 yourusername yourusername
}
```

### Process Monitoring

Create a monitoring script (monitor.sh) in your project directory:
```bash
#!/bin/bash

# Check if the process is running
if ! pm2 pid stremio-ai-addon > /dev/null; then
    echo "Stremio addon is not running. Restarting..."
    pm2 start ecosystem.config.js
    pm2 save
fi

# Check memory usage
memory_usage=$(pm2 prettylist | grep memory | awk '{print $2}')
if [ "$memory_usage" -gt 300000000 ]; then  # 300MB in bytes
    echo "Memory usage too high. Restarting..."
    pm2 reload stremio-ai-addon
fi

# Check if port 7000 is listening
if ! netstat -tuln | grep ":7000 " > /dev/null; then
    echo "Port 7000 is not listening. Restarting..."
    pm2 reload stremio-ai-addon
fi
```

Make it executable and add to crontab:
```bash
chmod +x monitor.sh
(crontab -l 2>/dev/null; echo "*/5 * * * * /path/to/your/stremio/monitor.sh >> /path/to/your/stremio/logs/monitor.log 2>&1") | crontab -
```

This setup provides:
- Automatic startup after server reboot
- Process management and monitoring
- Log rotation
- Memory monitoring
- Zero-downtime reloads
- Automatic recovery from crashes

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

### 9. Optional Server Setup

#### Auto-Restart and Process Management

1. Create a logs directory:
```bash
mkdir -p logs
chmod 755 logs
```

2. Update ecosystem.config.js with production settings:
```javascript
module.exports = {
    apps: [{
        name: "stremio-ai-addon",
        script: "./server.js",
        cwd: ".",
        env: {
            NODE_ENV: "production",
            PORT: 7000,
            HOST: "0.0.0.0"
        },
        watch: [
            "server.js",
            "addon.js"
        ],
        ignore_watch: [
            "node_modules",
            "*.log"
        ],
        max_memory_restart: "300M",    // Restart if memory exceeds 300MB
        instances: "max",              // Run in cluster mode with max instances
        exec_mode: "cluster",          // Enable cluster mode
        log_date_format: "YYYY-MM-DD HH:mm:ss Z",
        error_file: "./logs/error.log",
        out_file: "./logs/out.log",
        merge_logs: true,
        autorestart: true,             // Auto restart if app crashes
        restart_delay: 4000,           // Delay between automatic restarts
        max_restarts: 10,              // Number of times to restart before stopping
        exp_backoff_restart_delay: 100 // Delay between restarts
    }]
};
```

#### Log Rotation
Create a log rotation configuration to manage log files:

```bash
sudo nano /etc/logrotate.d/stremio-addon
```

Add the following content:
```
/path/to/your/stremio/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 644 yourusername yourusername
}
```

#### Systemd Service
Create a systemd service for automatic startup:

```bash
sudo nano /etc/systemd/system/stremio-addon.service
```

Add the following content:
```ini
[Unit]
Description=Stremio AI Addon
After=network.target

[Service]
Type=forking
User=yourusername
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=/path/to/your/stremio
ExecStart=/usr/local/bin/pm2 start ecosystem.config.js
ExecReload=/usr/local/bin/pm2 reload all
ExecStop=/usr/local/bin/pm2 kill
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl enable stremio-addon
sudo systemctl start stremio-addon
```

#### Process Monitoring
Create a monitoring script to automatically recover from failures:

1. Create monitor.sh in your project directory:
```bash
nano monitor.sh
```

2. Add the following content:
```bash
#!/bin/bash

# Check if the process is running
if ! pm2 pid stremio-ai-addon > /dev/null; then
    echo "Stremio addon is not running. Restarting..."
    pm2 start ecosystem.config.js
    pm2 save
fi

# Check memory usage
memory_usage=$(pm2 prettylist | grep memory | awk '{print $2}')
if [ "$memory_usage" -gt 300000000 ]; then  # 300MB in bytes
    echo "Memory usage too high. Restarting..."
    pm2 reload stremio-ai-addon
fi

# Check if port 7000 is listening
if ! netstat -tuln | grep ":7000 " > /dev/null; then
    echo "Port 7000 is not listening. Restarting..."
    pm2 reload stremio-ai-addon
fi
```

3. Make the script executable and add to crontab:
```bash
chmod +x monitor.sh
(crontab -l 2>/dev/null; echo "*/5 * * * * /path/to/your/stremio/monitor.sh >> /path/to/your/stremio/logs/monitor.log 2>&1") | crontab -
```

#### Verification Steps
```bash
# Check service status
sudo systemctl status stremio-addon

# View PM2 status
pm2 status

# Check logs
tail -f logs/out.log
tail -f logs/error.log
tail -f logs/monitor.log

# Test automatic startup
sudo reboot
```

These configurations will ensure your addon:
- Automatically starts after server reboot
- Restarts if it crashes or uses too much memory
- Maintains organized logs with rotation
- Monitors itself for issues

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- [Stremio Addon SDK](https://github.com/Stremio/stremio-addon-sdk)
- [Google Gemini AI](https://deepmind.google/technologies/gemini/)
- [TMDB API](https://developers.themoviedb.org/3)

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support
If you encounter any issues or have questions, please open an issue on GitHub.

## About me
I am a passionate developer dedicated to creating useful tools that can benefit the community. My goal is to distribute all of my projects as open source, enabling others to learn, contribute, and innovate together. If you appreciate my work and want to support my efforts, feel free to [buy me a coffee](https://buymeacoffee.com/itcon) :heart:!
