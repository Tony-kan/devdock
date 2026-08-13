import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Devdock — local services console",
  description: "Start, stop, update and watch the services in this workspace.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
