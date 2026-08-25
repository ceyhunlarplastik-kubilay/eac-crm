import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "EAPARAT CRM",
  description: "EAPARAT müşteri takip paneli"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr">
      <body>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
