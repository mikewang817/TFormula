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
if (mode === "exit-during-probe") {
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
