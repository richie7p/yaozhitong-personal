import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "public-shell-precache",
      async closeBundle() {
        const source = await readFile("public/sw.js", "utf8");
        const files = (await readdir("dist/web/assets")).filter((f) =>
          /\.(js|css)$/.test(f),
        );
        const version = createHash("sha256")
          .update(source + files.join("|"))
          .digest("hex")
          .slice(0, 12);
        await writeFile(
          "dist/web/sw.js",
          source
            .replace(
              "const BUILD_ASSETS = [];",
              "const BUILD_ASSETS = " +
                JSON.stringify(files.map((f) => "/assets/" + f)) +
                ";",
            )
            .replace("yzt-shell-v1", "yzt-shell-" + version),
        );
      },
    },
  ],
  build: { outDir: "dist/web" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});
