import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://spc-project-management-luke.wongkinlun9527.chatgpt.site"),
  title: "神銀建材｜SPC 工程管理系統",
  description: "神銀建材 SPC 地板工程的案場、施工、驗收與完工表單管理。",
  openGraph: {
    title: "神銀建材｜SPC 工程管理系統",
    description: "連工帶料工程管理，整合案場、施工、驗收與完工表單。",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "神銀建材 SPC 工程管理系統" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "神銀建材｜SPC 工程管理系統",
    description: "連工帶料工程管理，整合案場、施工、驗收與完工表單。",
    images: ["/og.jpg"],
  },
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
