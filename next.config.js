/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The legacy static export (public/legacy/*) gets iframed at the same
  // URL on every deploy. A query-string cache-bust on the iframe src alone
  // wasn't reliably preventing stale copies (browser cache, a proxy, or a
  // tab that was never fully reloaded can all still serve an old version).
  // Explicit headers are a stronger guarantee: always revalidate with the
  // server instead of trusting a local cache.
  async headers() {
    return [
      {
        source: "/legacy/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
