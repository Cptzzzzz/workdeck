import { defineConfig } from "vite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  server: { proxy: { "/api": { target: "http://127.0.0.1:8090", ws: true } } },
  build: { sourcemap: false },
  plugins: [
    {
      name: "workdeck-pdf-resources",
      configureServer(server) {
        server.middlewares.use("/assets/pdfjs/", (request, response, next) => {
          const name = (request.url || "").split("?", 1)[0];
          if (
            !/^(standard_fonts\/[A-Za-z0-9_.-]+\.(?:ttf|pfb)|cmaps\/[A-Za-z0-9_.-]+\.bcmap)$/.test(
              name.replace(/^\//, ""),
            )
          )
            return next();
          const source = join(
            webRoot,
            "node_modules",
            "pdfjs-dist",
            name.replace(/^\//, ""),
          );
          if (!existsSync(source)) return next();
          response.setHeader("Content-Type", "application/octet-stream");
          response.end(readFileSync(source));
        });
      },
      generateBundle() {
        for (const [directory, suffixes] of [
          ["standard_fonts", [".ttf", ".pfb"]],
          ["cmaps", [".bcmap"]],
        ] as const) {
          const root = join(webRoot, "node_modules", "pdfjs-dist", directory);
          for (const name of readdirSync(root)) {
            if (!suffixes.some((suffix) => name.endsWith(suffix))) continue;
            this.emitFile({
              type: "asset",
              fileName: `assets/pdfjs/${directory}/${name}`,
              source: readFileSync(join(root, name)),
            });
          }
        }
      },
    },
  ],
});
