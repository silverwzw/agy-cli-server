#!/usr/bin/env node

/**
 * Terminal Progress Bar Script
 * Increases progress by 1% every 0.2s until reaching 100%.
 * Emits both standard in-place terminal text and OSC 9;4 escape sequences
 * for xterm.js ProgressAddon / Web Terminal UI integration.
 */

const TOTAL = 100;
const INTERVAL_MS = 200; // 0.2 seconds per 1%
const BAR_WIDTH = 40;

let current = 0;

function renderProgressBar(percent) {
  const filledLength = Math.round((BAR_WIDTH * percent) / 100);
  const emptyLength = BAR_WIDTH - filledLength;
  const bar = "█".repeat(filledLength) + "░".repeat(emptyLength);

  // OSC 9;4 sequence: \x1b]9;4;<state>;<percent>\x07
  // state 1 = active progress
  const oscSequence = `\x1b]9;4;1;${percent}\x07`;

  process.stdout.write(`\r${oscSequence}[${bar}] ${String(percent).padStart(3)}%`);
}

// Clean up OSC progress bar on exit / interrupt
function cleanup() {
  // state 0 = remove progress bar
  process.stdout.write("\x1b]9;4;0;0\x07");
}

process.on("SIGINT", () => {
  cleanup();
  process.stdout.write("\nInterrupted.\n");
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// Initial render at 0%
renderProgressBar(current);

const timer = setInterval(() => {
  current += 1;
  renderProgressBar(current);

  if (current >= TOTAL) {
    clearInterval(timer);
    process.stdout.write("\nProgress complete (100%).\n");
    // Clear the web UI progress bar after a brief moment
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 500);
  }
}, INTERVAL_MS);
