FROM debian:stable-slim

WORKDIR /tmp

RUN \
  apt-get update && \
  apt-get install -y python3 pipx git openssh-server vim nodejs npm curl

RUN curl -fsSL https://antigravity.google/cli/install.sh | /bin/bash

RUN \
  apt-get install -y poppler-utils curl iputils-ping jq moreutils wget

WORKDIR /webterm

RUN npm i @xterm/xterm node-pty socket.io

RUN jq '.scripts = { start: "node server/index.js" }' package.json | sponge package.json

COPY ./build-data/index.js        /webterm/server/index.js
COPY ./build-data/index.html      /webterm/app/index.html
COPY ./build-data/app.js          /webterm/app/app.js
COPY ./build-data/init            /init
COPY ./build-data/settings.json   /root/.gemini/antigravity-cli/settings.json

RUN chmod u+x /init

RUN echo 'alias agy-full="agy --dangerously-skip-permissions"' >> /root/.bashrc

# RUN apt-get clean

# 8443:termjs ssh:2222 test port:8080
EXPOSE 8443 2222 8080

WORKDIR /agy

CMD ["/init"]
