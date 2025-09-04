# match your package.json's Playwright version
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app
COPY package*.json ./

# Fast/reproducible; if lockfile ever drifts, fallback to npm install
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Writeable path (pair with Render Disk if you want persistence)
RUN mkdir -p /data/screenshots && chown -R pwuser:pwuser /data /app

ENV NODE_ENV=production \
    OUTPUT_ROOT=/data/screenshots \
    PLAYWRIGHT_BROWSERS_PATH=0

USER pwuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "process.exit(0)"

CMD ["node", "bot.js"]