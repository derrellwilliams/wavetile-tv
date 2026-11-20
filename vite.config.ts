import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

/// webOS loads the app from file://, where Chromium refuses module scripts and anything marked
/// `crossorigin`. The bundle is one classic script, so the tags are rewritten to match.
/// Only the app's own script and styles may run; pictures, video and Jellyfin requests may come
/// from any server (the address is typed in at sign-in). `file:` is listed because a `file://`
/// page's own files don't reliably match 'self'. Build only: the dev server needs inline scripts.
const CSP = [
  "default-src 'none'",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "font-src 'self' file: data:",
  "img-src * data: blob:",
  "media-src * blob:",
  "connect-src *",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function webosHtml(): Plugin {
  return {
    name: "webos-html",
    enforce: "post",
    transformIndexHtml(html, context) {
      const policy = context.server ? "" : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    `;
      return html
        .replace("<title>", `${policy}<title>`)
        .replace(/<script type="module" crossorigin/g, "<script defer")
        .replace(/<link rel="stylesheet" crossorigin/g, '<link rel="stylesheet"');
    },
  };
}

/// The tablet loads the app from Capacitor's local server, so the TV's `file://` rewrites don't
/// apply; the page only needs a viewport that follows the screen instead of the TV's 1920×1080.
function androidHtml(): Plugin {
  return {
    name: "android-html",
    enforce: "post",
    transformIndexHtml(html, context) {
      const policy = context.server ? "" : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    `;
      return html
        .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover" />')
        .replace("<title>", `${policy}<title>`)
        .replace(/<script type="module" crossorigin/g, "<script defer")
        .replace(/<link rel="stylesheet" crossorigin/g, '<link rel="stylesheet"');
    },
  };
}

export default defineConfig(({ mode }) => {
  const android = mode === "android";
  return {
  // Relative URLs: the app is served from a folder on the TV, not a site root.
  base: "./",
  define: { __PLATFORM__: JSON.stringify(android ? "android" : "webos") },
  // webOS: appinfo.json and the launcher icons are copied to the root of dist as they are.
  // Android: the launcher icon is native, nothing is copied.
  publicDir: android ? false : "webos",
  plugins: [preact(), android ? androidHtml() : webosHtml()],
  build: {
    outDir: android ? "dist-android" : "dist",
    // webOS 24 is Chromium 108 and LG never updates it. The Fire HD 8's WebView is Chrome 138
    // (checked on the tablet), so the same target is safe there.
    target: "chrome108",
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      output: { format: "iife" },
    },
  },
  // Dev server only: check files on a timer. Where file-system events don't reach Vite (a sandboxed
  // Claude session), edits otherwise go unnoticed until the server restarts.
  server: { watch: { usePolling: true, interval: 300 } },
  test: { include: ["src/**/*.test.ts", "service/**/*.test.js", "scripts/**/*.test.mjs"] },
  };
});
