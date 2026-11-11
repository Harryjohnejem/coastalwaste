import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function quietJson(proxy) {
  proxy.on("error", (_err, _req, res) => {
    if (res && !res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ boxes: [], error: "detector_offline" }));
    }
  });
}

function quietOffline(proxy) {
  proxy.on("error", (_err, _req, res) => {
    if (res && !res.headersSent) {
      try {
        res.writeHead(502);
        res.end();
      } catch {
        /* already closed */
      }
    }
  });
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/detector": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
      "/overlay": {
        target: "http://127.0.0.1:8092",
        changeOrigin: true,
        configure: quietJson,
      },
      "/stream.mjpeg": {
        target: "http://127.0.0.1:8092",
        changeOrigin: true,
        configure: quietOffline,
      },
      "/frame.jpeg": {
        target: "http://127.0.0.1:8092",
        changeOrigin: true,
        configure: quietOffline,
      },
      "/datasets": {
        target: "http://127.0.0.1:8092",
        changeOrigin: true,
        configure: quietJson,
      },
      "/go2rtc": {
        target: "http://127.0.0.1:1990",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/go2rtc/, ""),
        configure: quietOffline,
      },
    },
  },
});
