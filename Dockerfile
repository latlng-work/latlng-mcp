FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/stdio.js ./src/stdio.js

ENV LATLNG_API_BASE_URL=https://api.latlng.work
CMD ["npm", "run", "start"]
