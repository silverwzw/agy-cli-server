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
  - Native xterm `linkHandler` intercepts `file:///` URLs (e.g., `file:///path/to/file#L10-L20`) and automatically opens the target file in the web viewer at the designated line range.
- **Bidirectional File Management**:
  - **Streaming Downloads** (`/control/download`): Downloads single files or dynamically archives whole directories as `.tar.gz`. Displays original file permissions, ownership, and copyable `chmod`/`chown` restore commands.
  - **Atomic Chunked Uploads** (`/control/upload`): Web UI supporting multi-file selection, folder drag-and-drop, inline renaming, overwrite conflict checks, and atomic temp-file rename on completion.
- **In-Browser Text File Viewer** (`/control/viewer`):

---

## Architecture & Security Model

1. **Reverse Proxy Assumption**:
   - The service is designed to be hosted behind an authenticating reverse proxy (such as Nginx with auth_request module, or Cloudflare with signin protection) that terminates TLS (HTTPS/WSS) and handles user authentication.
   - The application does not implement internal authentication or TLS encryption.
2. **Super Administrator Privileges**:
   - Any client that reaches the application through the reverse proxy is treated as a super administrator.
   - Root terminal execution, reading system files, and creating or overwriting files are intended administrative features.

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
| `/control/list` | Returns JSON list of active terminal sessions (PID, clients, uptime). |
| `/control/abort/:name` | Kills the session's PTY process tree and terminates the session. |
| `/control/download/{abs,rel}/<path>` | Downloads file or streams dynamic `.tar.gz` of the specified path. Append `?raw` for direct stream, `?download=0` for plain text. |
| `/control/upload` | `GET` serves upload page; `PUT` streams file upload with atomic rename. |
| `/control/viewer/{abs,rel}/<path>` | In-browser text viewer for text file at the specified path, append `?line=<line number or range>` for highlighting. |
