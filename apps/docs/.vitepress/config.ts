import { defineConfig } from "vitepress";

const repo = "https://github.com/bitsaspidy/bug-free-eureka";

// The Markdown lives in the repository's docs/ folder (single source); this app only builds it.
export default defineConfig({
  title: "Bug-Free Eureka",
  description: "Open-source API security toolkit for Node.js and Express.",
  srcDir: "../../docs",
  // Internal project files stay on GitHub, not on the site.
  srcExclude: ["AI_TEAM.md", "BLUEPRINT.md", "WORK_ORDERS.md"],
  base: "/bug-free-eureka/",
  cleanUrls: true,
  lastUpdated: true,
  // No analytics, fonts or other third-party requests.
  head: [["meta", { name: "referrer", content: "no-referrer" }]],
  themeConfig: {
    nav: [
      { text: "Quickstart", link: "/quickstart" },
      { text: "Rules", link: "/rules/" },
      { text: "GitHub", link: repo },
    ],
    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Quickstart", link: "/quickstart" },
          { text: "Limitations", link: "/limitations" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/cli" },
          { text: "Configuration", link: "/configuration" },
          { text: "Express adapter", link: "/express" },
        ],
      },
      {
        text: "Rules",
        items: [
          { text: "Overview", link: "/rules/" },
          { text: "BFE-001 Security headers", link: "/rules/BFE-001" },
          { text: "BFE-003 Request-size limit", link: "/rules/BFE-003" },
          { text: "BFE-005 Sensitive logging", link: "/rules/BFE-005" },
          { text: "BFE-006 Trusted proxy", link: "/rules/BFE-006" },
        ],
      },
      { text: "Deployment", items: [{ text: "Deployment guide", link: "/deployment" }] },
    ],
    search: { provider: "local" },
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: "Edit this page on GitHub" },
    socialLinks: [{ icon: "github", link: repo }],
    footer: { message: "Apache-2.0. A pass does not mean an application is secure." },
  },
});
