import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function postazioneHtmlOrderPlugin() {
  return {
    name: "postazione-html-order",
    apply: "build",
    enforce: "post",
    transformIndexHtml(html) {
      const script = html.match(/\n\s*<script type="module" crossorigin src="\/postazione\/assets\/index-[^"]+\.js"><\/script>/)?.[0];
      const style = html.match(/\n\s*<link rel="stylesheet" crossorigin href="\/postazione\/assets\/index-[^"]+\.css">/)?.[0];
      const override = /\n\s*<link rel="stylesheet" href="\/postazione\/assets\/postazione-layout-overrides\.css[^>]*>/;
      if (!script || !style || !override.test(html)) return html;
      return html
        .replace(script, "")
        .replace(style, "")
        .replace(override, `${script}${style}$&`);
    },
  };
}

export default defineConfig({
  base: "/postazione/",
  plugins: [react(), postazioneHtmlOrderPlugin()],
});
