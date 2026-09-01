import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AppFrame from "@/components/AppFrame";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WhatsApp Strategy Canvas",
  description: "Internal local tool for WhatsApp exports, library, and strategy boards",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
