# Antigravity CLI Server (`agy-cli-server`)

A containerized full permission Antigravity CLI, accessible through web browser.

---

## Features

- **Full Web Terminal Experience**:
  - Powered by [xterm.js](https://xtermjs.org/) in the browser and [node-pty](https://github.com/microsoft/node-pty) on the server.
  - Supports dual modes:
    - **Antigravity CLI mode** (`/a/<session>`): Directly runs `agy --dangerously-skip-permissions`.
    - **Interactive Bash mode** (`/s/<session>`): Spawns `/bin/bash` with full root privileges.
  - Automatic terminal resize synchronization, connection upgrade, and disconnect recovery buffer replay.
  - Integrated terminal features: in-terminal search (`Ctrl+F` / `Cmd+F`), OSC 9;4 terminal progress bar, clipboard integration, CJK characters support and image addon.
- **In-Terminal Hyperlinks & Seamless Viewer Navigation**:
  - Built-in `dl` helper command generates clickable ANSI OSC 8 download links directly in terminal output.
  - Built-in `export-conversation <id_prefix>` helper packages an `agy` conversation's database and brain assets into a `.tar.gz` archive with a download link.
  - Native xterm `linkHandler` intercepts `file:///` URLs (e.g., `file:///path/to/file#L10-L20`) and automatically opens the target file in the web viewer at the designated line range.
- **Bidirectional File Management**:
  - **Streaming Downloads** (`/control/download`): Downloads single files or dynamically archives whole directories as `.tar.gz`. Displays original file permissions, ownership, and copyable `chmod`/`chown` restore commands.
  - **Atomic Chunked Uploads** (`/control/upload`): Web UI supporting multi-file selection, folder drag-and-drop, inline renaming, overwrite conflict checks, and atomic temp-file rename on completion.

---

## Security Model

1. **Reverse Proxy & Authentication**:
   - The service can be hosted behind an authenticating reverse proxy (such as Nginx with `auth_request` module, or Cloudflare Access) that terminates TLS (HTTPS/WSS) and handles user authentication.
   - Alternatively, you can enable built-in **HTTP Basic Authentication** via the `HTTP_BASIC_AUTH` environment variable (recommended to still terminate TLS via a reverse proxy over untrusted networks).
   - If `HTTP_BASIC_AUTH` is unset or empty, built-in authentication is disabled.
2. **Super Administrator Privileges**:
   - Any authenticated client reaching the application is treated as a super administrator.
   - Root terminal execution, reading system files, and creating or overwriting files are intended administrative features.

### Optional HTTP Basic Authentication (`HTTP_BASIC_AUTH`)

Set the `HTTP_BASIC_AUTH` environment variable to `<username>:<sha256-crypt-hash>` (using standard SHA-256 crypt `$5$...` hashes) to protect all HTTP routes and Socket.IO/WebSocket connections:

1. **Generate a credential** (prompts for password without echoing to terminal/history):

   On Linux with OpenSSL:
   ```bash
   printf 'alice:%s\n' "$(openssl passwd -5)"
   ```

   Or cross-platform (including macOS/Windows) using the container image:
   ```bash
   docker run --rm -it silverwzw/agy-cli-server:latest sh -c 'printf "alice:%s\n" "$(openssl passwd -5)"'
   ```

   *(Optional)* Specify higher rounds (e.g. `50000`) with a random salt:
   ```bash
   printf 'alice:%s\n' "$(openssl passwd -5 -salt "rounds=50000\$$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9./' | head -c 16)")"
   ```

2. **Pass into the container**:
   - **Docker CLI** (use single quotes so `$` is not expanded by your shell):
     ```bash
     -e HTTP_BASIC_AUTH='alice:$5$...'
     ```
   - **Docker Compose** (escape every `$` as `$$` in `docker-compose.yaml` to prevent Compose variable interpolation):
     ```yaml
     environment:
       - HTTP_BASIC_AUTH=alice:$$5$$...
     ```

> **Notes**:
> - If `HTTP_BASIC_AUTH` is set to a malformed value (missing `:`, empty username/hash, or non-`$5$` hash), the server refuses to start.
> - Do not enable `HTTP_BASIC_AUTH` together with an upstream reverse proxy that injects its own `Authorization` header (browsers send only one `Authorization` header per origin).

---

## Quick Start

### Build the Docker Image

```bash
docker build -t silverwzw/agy-cli-server:latest .
```

### Run with Docker CLI

```bash
docker run -d \
  --name agy-webterm \
  -p 8443:8443 \
  -p 8080:8080 \
  -v ./workspace:/agy \
  -v ./secrets/agy-token:/root/.gemini/antigravity-cli/antigravity-oauth-token \
  silverwzw/agy-cli-server:latest
```

Note: the `./secrets/agy-token` is used to persist antigravity oauth token, you can just use a blank file during your initial setup. After your first login, the token will be written into this file automatically. You may choose to not supply this file at all, in such case you will need to login again everytime you recreate the container.

Open `http://localhost:8443` in your browser.

---

## Docker Compose Configurations

### 1. Standard Deployment

A standard `docker-compose.yaml` mounting a local workspace directory and Antigravity OAuth credentials:

```yaml
services:
  agy-webterm:
    image: silverwzw/agy-cli-server:latest
    container_name: agy-webterm
    restart: unless-stopped
    ports:
      - "8443:8443"  # Web terminal and file management
      - "8080:8080"  # Development preview port for apps built by agy
    volumes:
      # Workspace directory mounted into container working directory /agy
      - ./workspace:/agy
      # Antigravity CLI OAuth authentication token
      - ./secrets/agy-token:/root/.gemini/antigravity-cli/antigravity-oauth-token:ro
```

See above for an explaination of the `./secrets/agy-token` file.

---

### 2. Read-Only Base with OverlayFS Volume Deployment

This configuration mounts a base directory from the host as **read-only** (`lowerdir`), while all file additions, edits, and deletions made inside the container are stored in a separate host directory (`upperdir`).

This allows the container to freely experiment, build, and modify files without altering the original base files on the host.

Note: OverlayFS requires `upperdir` and `workdir` to reside on the **same filesystem**.

#### `docker-compose.yaml` with Overlay Volume

```yaml
services:
  webterm:
    image: silverwzw/agy-cli-server:latest
    container_name: agy-webterm-overlay
    restart: unless-stopped
    ports:
      - "8443:8443"
      - "8080:8080"
    volumes:
      # Mount the OverlayFS volume into /agy
      - workspace_overlay:/agy
      # Mount Antigravity CLI authentication token
      - ./secrets/agy-token:/root/.gemini/antigravity-cli/antigravity-oauth-token:ro
    environment:
      - LANG=C.UTF-8
      - TERM=xterm-256color
      - COLORTERM=truecolor

volumes:
  workspace_overlay:
    driver: local
    driver_opts:
      type: "overlay"
      device: "overlay"
      o: "lowerdir=/absolute/path/to/data/overlay/base,upperdir=/absolute/path/to/data/overlay/diff,workdir=/absolute/path/to/data/overlay/work"
```

See above for an explaination of the `./secrets/agy-token` file.

#### How It Works

| Path Component | Location | Role & Behavior |
| :--- | :--- | :--- |
| `lowerdir` | Host base directory (`base`) | Read-only foundation. The container can view and execute files from here, but can never modify them. |
| `upperdir` | Host diff directory (`diff`) | Writable layer. Any files created, edited, or deleted inside `/agy` are recorded here as copy-on-write diffs. |
| `workdir` | Host work directory (`work`) | Scratch space used internally by Linux OverlayFS for atomic operations. |
| `/agy` | Container mount point | Merged view presented to `agy` and `/bin/bash`. |

To reset the workspace back to its original base state at any time, simply stop the container, delete the contents of `diff` and `work`, and restart:

```bash
docker compose down
rm -rf ./data/overlay/diff/* ./data/overlay/work/*
docker compose up -d
```

---

## Endpoints & URL Reference

| Route | Description |
| :--- | :--- |
| `/` | Redirects to a new Antigravity session. |
| `/a` or `/s` | Redirects to a new Antigravity (`/a`) or Shell (`/s`) session. |
| `/a/:name` | Attach to the exisiting or create a new `agy` CLI session.  |
| `/s/:name` | Attach to the exisiting or create a new shell session. |
| `/control/list` | Returns JSON list of active terminal sessions (PID, clients, uptime, aliases). |
| `/control/alias/:id/:alias` | Binds `<alias>` to the session identified by `<id>` (session name or existing alias). |
| `/rr` or `/control/roundrobin` | Redirects to the next active session in round-robin order. |
| `/control/abort/:name` | Kills the session's PTY process tree and terminates the session. |
| `/control/download/:mode/{*path}` | Downloads file or streams dynamic `.tar.gz` of the specified path. Append `?raw` for direct stream, `?download=0` for plain text. |
| `/control/upload` | `GET` serves upload page; `PUT` streams file upload with atomic rename. |
| `/control/viewer/:mode/{*path}` | In-browser text viewer for text file at the specified path, append `?line=<line number or range>` for highlighting. |
