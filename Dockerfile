FROM node:20

WORKDIR /app

# Install system dependencies for Firefox/Camoufox
RUN apt-get update && apt-get install -y \
    libgtk-3-0 \
    libdbus-glib-1-2 \
    libxt6 \
    libx11-xcb1 \
    libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json tsconfig.json ./

RUN npm i

# Fetch Camoufox browser binaries
RUN npx camoufox-js fetch

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /app/data/screenshots

# Set environment
ENV NODE_ENV=production
ENV HEADLESS=true

# Run the application
# CMD ["node", "dist/index.js"]
