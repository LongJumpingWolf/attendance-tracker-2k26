/** @type {import('next').NextConfig} */
const nextConfig = {
  // Development only. Next.js 16 refuses to serve its dev scripts to any address except localhost, so opening the
  // dev server from a phone or another computer (http://192.168.x.x:3000) showed the page but never made it
  // interactive. These cover the usual home and office network ranges, so the address can change freely.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The address printed on the QR code or written to the NFC tag. It stays fixed while the app behind it changes.
  async redirects() {
    return [{ source: '/scan', destination: '/?scan=1', permanent: false }]
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/javascript; charset=utf-8',
          },
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          {
            key: 'Service-Worker-Allowed',
            value: '/',
          },
        ],
      },
      {
        source: '/firebase-messaging-sw.js',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/javascript; charset=utf-8',
          },
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          {
            key: 'Service-Worker-Allowed',
            value: '/',
          },
        ],
      },
    ]
  },
}

export default nextConfig
