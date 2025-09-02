FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "bot.js"]