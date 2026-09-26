import type { MetadataRoute } from "next";

// Lets the app be added to the home screen and open full-screen on phones.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Live Fact Check",
    short_name: "Fact Check",
    description: "Real-time fact-checking for live debates.",
    start_url: "/",
    display: "standalone",
    background_color: "#111113",
    theme_color: "#111113",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
