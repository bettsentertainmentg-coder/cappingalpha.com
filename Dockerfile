FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production --build-from-source

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
