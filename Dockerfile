# Use Node.js 20 slim image for production
FROM node:20-slim

# Set working directory
WORKDIR /app

# Install dependencies needed for some native modules if any (optional but safer)
# RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files first for better caching
COPY package.json package-lock.json ./

# Install dependencies needed for production and healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install only production dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create necessary directories for persistence
RUN mkdir -p logs query_results

# Set default environment variables
ENV NODE_ENV=production
ENV TRANSPORT=sse
ENV PORT=3333

# Expose the server port
EXPOSE 3333

# switch to non-root user for security
USER node

# Start the server
CMD ["npm", "run", "start:sse"]