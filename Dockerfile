FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Production mode: Express omits stack traces from error responses, and libs skip
# dev-only overhead. (Railway also sets its own env; this is the baseline.)
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --production --build-from-source

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
