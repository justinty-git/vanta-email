import "./globals.css";

export const metadata = {
  title: "Email Ready Room",
  description: "Command Center for Email — Vanta Marketing Ops",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
