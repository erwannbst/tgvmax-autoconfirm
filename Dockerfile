# Multi-stage build for smaller image
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Production stage with Playwright
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install Node.js 20
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create data directory for session storage
RUN mkdir -p /app/data/screenshots && \
    chown -R pwuser:pwuser /app

# Switch to non-root user
USER pwuser

# Set environment
ENV NODE_ENV=production
ENV HEADLESS=true

# Run the application
CMD ["node", "dist/index.js"]
