#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (!/^nuanu_flow_[0-9a-f]{64}$/.test(process.env.NUANU_AGENT_KEY ?? "")) {
    process.exit(31);
  }
  if (
    process.env.NUANU_TOKEN ||
    process.env.NUANU_DEV_TOKEN ||
    process.env.NUANU_DEV_AGENT_KEY
  ) {
    process.exit(32);
  }
  if (!input.includes("portable-live-ok")) {
    process.exit(33);
  }
  process.stdout.write("portable-live-ok");
});
