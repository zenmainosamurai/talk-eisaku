import { defineConfig } from "vite";

// web ブランチ：GitHub Pages（https://<ユーザー名>.github.io/talk-eisaku/）でも動くよう、ファイルを相対パスで読む
export default defineConfig({
  base: "./",
  build: { outDir: "dist", target: "es2020" }
});
