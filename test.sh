docker build -t silverwzw/agy-cli-server:dev . && \
docker run -p 5999:8443 \
           -v ./data/secrets/agy-token:/root/.gemini/antigravity-cli/antigravity-oauth-token \
		   -v .:/source \
		   -v ./data/dev_init:/dev_init \
		   -it silverwzw/agy-cli-server:dev /dev_init
