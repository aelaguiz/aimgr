export function isInteractiveTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return Boolean(stdin?.isTTY) && Boolean(stdout?.isTTY);
}
