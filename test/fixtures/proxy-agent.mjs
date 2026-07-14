const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Behave like a real full-screen Agent: raw input makes any terminal response
// accidentally forwarded by TFormula immediately observable in the transcript.
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  process.stdout.write(`TFORMULA_UNEXPECTED_CHILD_INPUT:${Buffer.from(chunk).toString("hex")}\n`);
});

async function writeFragmented(value, pattern = [1, 2, 5, 3, 8]) {
  let offset = 0;
  let patternIndex = 0;
  while (offset < value.length) {
    const length = pattern[patternIndex % pattern.length];
    process.stdout.write(value.slice(offset, offset + length));
    offset += length;
    patternIndex += 1;
    // Force node-pty to expose the control sequence through more than one
    // onData callback instead of merely splitting one JavaScript write.
    await delay(1);
  }
}

process.stdout.write("TFORMULA_FIXTURE_BEGIN\n");

// A long line forces character-based output checkpoints even though it never
// contains LF. The sentinels let the end-to-end test verify byte ordering.
process.stdout.write(`LONG_NO_LF_BEGIN:${"x".repeat(1_600)}:LONG_NO_LF_END\n`);

// These are legitimate controls emitted by the wrapped Agent, not TFormula
// graphics. Both are deliberately fragmented at arbitrary byte boundaries.
await writeFragmented("\x1b]0;agent-title-with-ESC-[2J-and-iVBORw0KGgo\x1b\\");
await writeFragmented("\x1b_Gi=73,m=0;Q0hJTERfQVBDX1BBWUxPQUQ=\x1b\\", [1, 1, 2, 1, 3]);
process.stdout.write("\n");

const formulas = [
  String.raw`\nabla \cdot \mathbf{E}=\frac{\rho}{\varepsilon_0}`,
  String.raw`\nabla \cdot \mathbf{E}=\frac{\rho}{\varepsilon_0}`,
  String.raw`\nabla \times \mathbf{B}=\mu_0\mathbf{J}+\mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}`
];

for (let index = 0; index < formulas.length; index += 1) {
  process.stdout.write(`${index + 1}. Formula ${index + 1}\n\n`);
  // Fragment the TeX too, including immediately before and after delimiters.
  await writeFragmented(`$$${formulas[index]}$$\n\n`, [2, 1, 7, 3, 1, 11]);
  process.stdout.write(`Explanation ${index + 1}.\n`);
}

process.stdout.write("TFORMULA_FIXTURE_READY\n");
// Keep the child alive while the harness repeatedly changes the outer PTY
// geometry. TFormula must probe and reconcile every resulting layout epoch.
await delay(1_800);
process.stdout.write("TFORMULA_FIXTURE_END\n");
process.stdin.removeAllListeners("data");
process.stdin.pause();
