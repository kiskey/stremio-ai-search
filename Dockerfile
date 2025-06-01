FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Expose port if needed (optional)
EXPOSE 7000

# Start the app
CMD ["npm", "start"]
