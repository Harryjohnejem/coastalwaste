import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const storageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../api/storage/app/public");

function storageStatic() {
  const types = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
  };
  return {
    name: "storage-static",
    configureServer(server) {
      server.middlewares.use("/storage", (req, res, next) => {
        const raw = decodeURIComponent((req.url || "/").split("?")[0]);
        const file = path.normalize(path.join(storageRoot, raw));
        if (!file.startsWith(storageRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=3600");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

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
  plugins: [react(), storageStatic()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
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
      "/annotated.jpeg": {
        target: "http://127.0.0.1:8092",
        changeOrigin: true,
        configure: quietOffline,
      },
      "/annotated.mjpeg": {
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
