# Single-stage build keeps things simple & reliable for first-time Docker users.
# node:20-bookworm has the build tools needed by better-sqlite3 (native module).
FROM node:20-bookworm

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install

# Build TypeScript -> dist
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# SQLite file lives on a mounted volume
RUN mkdir -p /data

EXPOSE 8080
CMD ["node", "dist/index.js"]
