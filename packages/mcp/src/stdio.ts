import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadAiruxRuntimeConfig } from "./config.js";
import { createAiruxMcpServer } from "./server.js";

const config = loadAiruxRuntimeConfig();
const handle = serveStdio(() => createAiruxMcpServer({ config }), {
  onerror() {
    process.stderr.write("AirUX MCP transport error\n");
  },
});

process.once("SIGINT", () => {
  void handle.close().finally(() => process.exit(0));
});
