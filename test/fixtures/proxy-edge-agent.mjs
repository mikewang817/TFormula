const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  process.stdout.write(`TFORMULA_UNEXPECTED_CHILD_INPUT:${Buffer.from(chunk).toString("hex")}\n`);
});

const mode = process.env.TFORMULA_EDGE_MODE;
process.stdout.write(`TFORMULA_EDGE_READY:${mode}\n`);
if (mode === "idle-pending-resize") {
  // Keep the cursor line separate from the readiness sentinel. OSC title
  // markers let the outer PTY coordinate two resizes without moving the
  // terminal cursor or clearing its hidden pending-wrap state.
  process.stdout.write("\\[\r\nx=1\r\n\\]\x1b[6;1H" + "a".repeat(10));
  process.stdout.write("\x1b]0;TFORMULA_PENDING_PHASE_1\x1b\\");
  await new Promise((resolve) => process.once("SIGWINCH", resolve));
  process.stdout.write("b".repeat(30));
  process.stdout.write("\x1b]0;TFORMULA_PENDING_PHASE_2\x1b\\");
  // Stay completely idle long enough for the post-resize scan. If TFormula
  // cannot restore pending-wrap, no later child output is available to hide
  // the bug by triggering another scan.
  await delay(1_200);
} else if (mode === "exit-during-probe") {
  await delay(25);
  process.stdout.write(`$$E=mc^2$$\n${"checkpoint\n".repeat(30)}`);
  await delay(10);
} else {
  // Startup terminal replies deliberately arrive after probeTerminal's fixed
  // collection window and while this raw-mode child is already running.
  await delay(550);
  process.stdout.write("$$E=mc^2$$\n");
}
process.stdout.write("TFORMULA_EDGE_END\n");
process.stdin.removeAllListeners("data");
process.stdin.pause();
