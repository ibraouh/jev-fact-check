import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700", "800"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Live Fact Check",
  description: "Real-time fact-checking for live debates, powered by Jev and Claude.",
  appleWebApp: { capable: true, title: "Fact Check", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d10",
};

// Applies the saved theme before first paint so the page never flashes the wrong one.
// Dark is the default; "system" follows the phone.
const themeScript = `try{var t=localStorage.getItem("theme")||"dark";if(t!=="system")document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
