FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib

ENV PORT=8790 \
    ALERTS_DATA_DIR=/data \
    TZ=UTC
VOLUME ["/data"]
EXPOSE 8790

CMD ["node", "server.js"]
