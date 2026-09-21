# Project Overview
This project provides a containerized web terminal and workspace environment designed for running the Google Antigravity CLI (`agy`) and related workflows in the browser. It features a web terminal (powered by xterm.js in the browser and node-pty on the server), bidirectional file transfer capabilities (streaming downloads with dynamic tar.gz directory archiving, and atomic chunked uploads), and in-terminal CLI helper tools (such as `dl` for clickable terminal download links). The service is designed to be hosted behind an authenticating reverse proxy with full administrative privileges inside the container.

# File Hierarchy
- `Dockerfile`: Multi-stage Docker build recipe for bundling frontend assets and building the runtime container image.
- `test.sh`: Script to build and run the development container locally with port mappings and volume mounts.
- `build-data/`: Production application assets and source code packaged into the container:
  - `init`: Container entrypoint script initializing ssh-agent and launching the Node.js server.
  - `dl`: Terminal CLI helper script generating clickable ANSI OSC 8 download hyperlinks for files and directories.
  - `settings.json`: Configuration template for the Antigravity CLI.
  - `package.json`, `package-lock.json`: Production Node.js runtime dependencies (Express, Socket.IO, node-pty, tar-fs, etc.).
  - `builder/`: Build-time configuration and dependencies (e.g., esbuild) used in the Docker build stage to bundle client assets.
  - `client/`: Browser-side frontend assets:
    - `index.html`, `main.js`: Main web terminal UI and Socket.IO client logic (xterm.js, resize handling, reconnect buffer replay).
    - `download.html`, `download.js`: Web page and client logic for file and directory downloads.
    - `upload.html`, `upload.js`: Web page and client logic for file uploads with drag-and-drop and progress tracking.
  - `server/`: Server-side Node.js / Express application:
    - `entry.js`: Application entry point managing HTTP routes, Socket.IO terminal sessions, and lifecycle endpoints.
    - `download.js`: Download handler serving single files or streaming tar.gz directory archives.
    - `upload.js`: Upload handler processing atomic file uploads with temp files, overwrite verification, and disconnect cleanup.
    - `util.js`: Shared server utilities (such as browser prefetch/prerender detection).
- `data/`: Local development mounts and secrets:
  - `dev_init`: Initialization script used when running the development container.
  - `secrets/`: Local directory holding sensitive credentials (e.g., `agy-token`), excluded from version control.
- `util/`: Helper scripts used for development or maintenance (e.g., `progress_bar.js`).
- `.agent_worklog/`: Historical record of agent and user interaction logs.

# Agent Rules

## 1. Prohibition on `/webterm` Directory and Files
- **No Modifications**: Strictly prohibit modifying, creating, editing, overwriting, or deleting any files or directories under `/webterm` and its subdirectories.
- **No Execution**: Strictly prohibit running or executing any files, scripts, binaries, commands, or processes in `/webterm` and its subdirectories.

## 2. Git Operations and VCS Restrictions
- **Read-Only Git Allowed**: Permitted to execute read-only Git commands (such as `git status`, `git diff`, `git log`, `git show`, `git branch --list`, `git grep`, etc.).
- **No State-Changing Commands**: Strictly prohibit executing any Git commands that modify Git state or repository history (including but not limited to `git add`, `git commit`, `git push`, `git merge`, `git rebase`, `git tag`, `git branch -d`, etc.).
- **No Working Tree / Index Modifying Commands**: Strictly prohibit executing any Git commands that modify, reset, or checkout the working directory or staging area (including but not limited to `git checkout`, `git stash`, `git restore`, `git reset`, `git clean`, `git switch`, etc.).
- **No Changes to `.git`**: Strictly prohibit modifying, creating, or deleting any files or directories under `.git`.
- **No Changes to `.gitignore`**: Strictly prohibit modifying, editing, or overwriting `.gitignore`.

## 3. Language Requirements for Code and Configuration Files
- **English for Code and Configs**: All generated code, comments, docstrings, and configuration files must be written in English.
- **Exemption for `agent_worklog/`**: Files under `agent_worklog/` are exempt and must always record the original dialogue verbatim, preserving whichever language was used in the conversation.

## 4. Development and Testing Restrictions
- **No Dev-Path Compatibility in Code**: Strictly prohibit writing code or fallback logic to accommodate the development environment (`/source`). The codebase must target the production runtime structure (`/webterm`) only.
- **No Direct Execution in Development**: Strictly prohibit running application code directly within the development environment (`/source`).
- **Testing via Dedicated Temporary Directory**: If code needs to be executed or tested, copy the required files to a dedicated temporary test directory mimicking the expected runtime structure.

## 5. Deployment Architecture and Privilege Model
- **Reverse Proxy Assumption**: The project assumes it is deployed behind a reverse proxy that handles user authentication, access control, and TLS termination (converting HTTP to HTTPS). The application does not need to implement internal authentication or TLS handling.
- **Super Administrator Privileges**: Any client accessing this service via the reverse proxy is treated as a super administrator with complete control over the system. Therefore, executing root interactive shells, downloading or reading system-critical files, and creating or overwriting arbitrary system files are intended administrative features, not security vulnerabilities.


