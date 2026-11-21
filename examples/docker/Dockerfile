FROM node:24-bookworm-slim

WORKDIR /app

# Baked into the image and visible in process.env unless overridden at runtime.
ENV LOG_LEVEL=info

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

CMD ["node", "index.js"]
