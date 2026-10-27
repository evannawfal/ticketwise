import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ticketwise · AI support assistant",
  description: "Answers support questions from your help docs and past tickets, with citations. Drafts agent replies and works in Slack.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
