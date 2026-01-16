FROM node:20-bookworm

WORKDIR /app

# Install Playwright with system dependencies
RUN npx -y playwright@1.57.0 install --with-deps

# Copy package files
COPY package*.json tsconfig.json ./

# Install dependencies
RUN npm ci

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
CMD ["node", "dist/index.js"]
