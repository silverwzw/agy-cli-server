FROM debian:stable-slim

RUN \
  apt-get update && \
  apt-get install -y vim && \
  apt-get install -y python3 pipx git vim nodejs npm curl iputils-ping && \
  apt-get install -y poppler-utils jq moreutils wget

RUN curl -fsSL https://antigravity.google/cli/install.sh | /bin/bash

WORKDIR /webterm

RUN npm i \
      @xterm/xterm \
	  @xterm/addon-fit \
	  @xterm/addon-clipboard \
	  @xterm/addon-web-links \
	  node-pty \
	  socket.io 

RUN jq '.scripts = { start: "node server/entry.js" }' package.json | sponge package.json

COPY ./build-data/server.js       /webterm/server/entry.js
COPY ./build-data/index.html      /webterm/client/index.html
COPY ./build-data/client.js       /webterm/client/main.js
COPY ./build-data/init            /init
COPY ./build-data/settings.json   /root/.gemini/antigravity-cli/settings.json

RUN chmod u+x /init && \
    echo 'alias agy-full="agy --dangerously-skip-permissions"' >> /root/.bashrc

# RUN apt-get clean

# 8443:termjs test port:8080
EXPOSE 8443 8080

WORKDIR /agy

CMD ["/init"]
