# Stage 1: install dependencies (build stage)
FROM node:23-alpine AS build

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production=true

# Copy source code
COPY . .

# Stage 2: runtime stage with minimal image
FROM node:23-alpine

WORKDIR /usr/src/app

# Copy installed node_modules and app source from build stage
COPY --from=build /usr/src/app .

# Expose the port your app listens on
EXPOSE 7000

# Set environment variables if needed
ENV NODE_ENV=production
ENV ENABLE_LOGGING=true

# Create logs directory if your app writes logs here
RUN mkdir -p logs

# Run the app
CMD ["node", "server.js"]
