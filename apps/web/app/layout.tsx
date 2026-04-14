import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
// Analytics: Vercel Analytics removed. Add your preferred analytics provider here.
// import { Analytics } from "@vercel/analytics/next";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const themeInitializationScript = `
(() => {
  const storageKey = "open-agents-theme";
  const darkModeMediaQuery = "(prefers-color-scheme: dark)";
  const storedTheme = window.localStorage.getItem(storageKey);

  const theme =
    storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
      ? storedTheme
      : "system";

  const resolvedTheme =
    theme === "system"
      ? window.matchMedia(darkModeMediaQuery).matches
        ? "dark"
        : "light"
      : theme;

  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
})();
`;

const isPreviewDeployment = process.env.DEPLOY_ENV === "preview" || process.env.VERCEL_ENV === "preview";
const faviconPath = isPreviewDeployment
  ? "/favicon-preview.svg"
  : "/favicon.ico";

// Support multiple hosting platforms for metadata base URL
const metadataBase = (() => {
  const customUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (customUrl) return new URL(customUrl);

  // Cloudflare Pages
  const cfUrl = process.env.CF_PAGES_URL;
  if (cfUrl) return new URL(cfUrl);

  // Vercel
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }
  if (process.env.VERCEL_URL) {
    return new URL(`https://${process.env.VERCEL_URL}`);
  }

  return new URL("https://open-agents.dev");
})();

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "Open Agents",
    template: "%s | Open Agents",
  },
  description:
    "Spawn coding agents that run infinitely in the cloud. Powered by AI SDK, Gateway, Sandbox, and Workflow SDK.",
  icons: {
    icon: faviconPath,
    shortcut: faviconPath,
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans overflow-x-hidden antialiased`}
      >
        <script
          dangerouslySetInnerHTML={{ __html: themeInitializationScript }}
        />
        <Providers>{children}</Providers>
        {/* Analytics provider placeholder */}
      </body>
    </html>
  );
}
