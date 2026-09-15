FROM debian:stable-slim

RUN \
  apt-get update && \
  apt-get install -y \
    curl \
    git \
    iputils-ping \
    jq \
    moreutils \
    nodejs \
    npm \
    pipx \
    poppler-utils \
    procps \
    python3 \
    vim \
    wget

RUN curl -fsSL https://antigravity.google/cli/install.sh | /bin/bash

COPY ./build-data/settings.json       /root/.gemini/antigravity-cli/settings.json
COPY ./build-data/init                /init

RUN chmod u+x /init && \
    echo 'alias agy="/root/.local/bin/agy --dangerously-skip-permissions"' >> /root/.bashrc

WORKDIR /webterm

RUN npm i \
      @xterm/xterm \
      @xterm/addon-fit \
      @xterm/addon-clipboard \
      @xterm/addon-web-links \
      @xterm/addon-image \
      @xterm/addon-progress \
      @xterm/addon-search \
      node-pty \
      express \
      socket.io

RUN jq '.scripts = { start: "node server/entry.js" }' package.json | sponge package.json

COPY ./build-data/index.html          /webterm/client/index.html
COPY ./build-data/upload.html         /webterm/client/upload.html
COPY ./build-data/upload.js           /webterm/client/upload.raw.js
COPY ./build-data/download.html       /webterm/client/download.html
COPY ./build-data/download.js         /webterm/client/download.raw.js
COPY ./build-data/client.js           /webterm/client/main.raw.js

COPY ./build-data/upload-handler.js   /webterm/server/upload-handler.js
COPY ./build-data/download-handler.js /webterm/server/download-handler.js
COPY ./build-data/server.js           /webterm/server/entry.js

WORKDIR /webterm/client

RUN npx --yes esbuild main.raw.js --minify --outfile=main.js && \
    npx --yes esbuild download.raw.js --minify --outfile=download.js && \
    npx --yes esbuild upload.raw.js --minify --outfile=upload.js

RUN apt-get clean && rm -rf /var/lib/apt/lists/*

# 8443:termjs test port:8080
EXPOSE 8443 8080

WORKDIR /agy

CMD ["/init"]

# vim: set list listchars=trail\:· sw=4 ts=4 expandtab:
