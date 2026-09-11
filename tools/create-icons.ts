import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const browser = await chromium.launch();
try {
  const svg = await readFile("public/icon.svg", "utf8");
  for (const size of [192, 512]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>${svg}`,
    );
    await page.screenshot({
      path: `public/icon-${size}.png`,
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
const manifest = JSON.parse(
  await readFile("public/manifest.webmanifest", "utf8"),
);
manifest.icons = [
  ...manifest.icons.filter((i: any) => i.type === "image/svg+xml"),
  ...[192, 512].map((size) => ({
    src: `/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose: "any maskable",
  })),
];
await writeFile(
  "public/manifest.webmanifest",
  JSON.stringify(manifest, null, 2),
);
