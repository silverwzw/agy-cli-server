FROM node:slim AS builder

WORKDIR /build
COPY ["./build-data/client.js", "./build-data/download.js", "./build-data/upload.js", "./"]

RUN npx --yes esbuild download.js --minify --allow-overwrite --outfile=download.js && \
    npx --yes esbuild upload.js   --minify --allow-overwrite --outfile=upload.js && \
    npx --yes esbuild client.js   --minify --outfile=main.js

FROM debian:stable-slim AS final

RUN \
  apt-get update && \
  apt-get install -y \
    iputils-ping traceroute iproute2 net-tools \
    nodejs npm python3 pipx \
    curl wget \
    procps busybox sysstat moreutils cron \
    poppler-utils \
    git jq \
    vim ack && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://antigravity.google/cli/install.sh | /bin/bash

COPY ./build-data/settings.json       /root/.gemini/antigravity-cli/settings.json
COPY ./build-data/init                /init

RUN chmod u+x /init && \
    systemctl enable cron && \
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

RUN jq '.scripts = { start: "node server/server.js" }' package.json | sponge package.json

COPY --from=builder ["/build/main.js", "/build/download.js", "/build/upload.js", "/webterm/client/"]
COPY ["./build-data/index.html", "./build-data/upload.html", "./build-data/download.html",  "/webterm/client/"]
COPY ["./build-data/upload-handler.js", "./build-data/download-handler.js", "./build-data/server.js", "/webterm/server/"]

# 8443 for terminal webaccess
# 8080 to access any application developed by agy
EXPOSE 8443 8080

WORKDIR /agy

CMD ["/init"]

# vim: set list listchars=trail\:· sw=4 ts=4 expandtab:
