FROM node:22-alpine

RUN npm install -g @webos-tools/cli

WORKDIR /app
COPY updater.js /app/updater.js

# The webOS device key lives here, created once during pairing, so no host
# key files are copied into the image or bind-mounted from the host.
VOLUME /root

CMD ["node", "updater.js"]
