FROM node:slim AS builder

WORKDIR /build

COPY ["./build-data/builder/*", "/build/"]

RUN npm install

COPY ["./build-data/client/*.js", "/build/"]

RUN npx --yes esbuild upload.js   --minify --allow-overwrite --bundle --outfile=upload.js && \
    npx --yes esbuild download.js --minify --allow-overwrite --outfile=download.js && \
    npx --yes esbuild main.js     --minify --allow-overwrite --outfile=main.js

FROM debian:stable-slim AS final

RUN apt-get update && \
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
    echo 'alias agy="/root/.local/bin/agy --dangerously-skip-permissions"' >> /root/.bashrc

WORKDIR /webterm

COPY ["./build-data/package.json", "./build-data/package-lock.json", "/webterm/"]

RUN npm install

COPY --from=builder ["/build/*.js", "/webterm/client/"]
COPY ["./build-data/client/*.html",  "/webterm/client/"]
COPY ["./build-data/server", "/webterm/server/"]

# 8443 for terminal webaccess
# 8080 to access any application developed by agy
EXPOSE 8443 8080

WORKDIR /agy

CMD ["/init"]

# vim: set list listchars=trail\:· sw=4 ts=4 expandtab:
