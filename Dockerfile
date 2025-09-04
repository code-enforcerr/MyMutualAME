# Use official Playwright image with all browser deps preinstalled
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# App directory
WORKDIR /app

# Only copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install prod deps
RUN npm ci --only=production

# Copy source
COPY . .

# Create a writable data mount for screenshots/zips (optional persistent disk)
RUN mkdir -p /data/screenshots && chown -R pwuser:pwuser /data /app

# Runtime env (can be overridden in Render)
ENV NODE_ENV=production \
    OUTPUT_ROOT=/data/screenshots

# Non-root user recommended in Playwright image
USER pwuser

# Start the worker
CMD ["node", "bot.js"]