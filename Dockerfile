# Use Node.js 20 LTS Alpine image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy the source code
COPY . .

# Build the TypeScript project
RUN npm run build

# Set environment port
ENV PORT=3000

# Expose port
EXPOSE 3000

# Run the app
CMD ["node", "dist/index.js"]
