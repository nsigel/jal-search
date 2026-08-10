import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "JAL Award Helper",
    short_name: "JAL Helper",
    description: "Adds cabin and cash calendar context to JAL award searches.",
    permissions: ["storage"],
    host_permissions: [
      "https://book-i.jal.co.jp/*",
      "https://www.jal.co.jp/*",
      "https://jallogin.jal.co.jp/*"
    ],
    action: {
      default_title: "JAL Award Helper"
    }
  }
});
