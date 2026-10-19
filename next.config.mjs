/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { formats: ['image/avif', 'image/webp'] },
  // The stylesheet is inlined into each page, so the first paint does not wait for a CSS request.
  experimental: { inlineCss: true },
  // Sign in and sign up live on one page now; old links keep working (query strings such as ?site= pass through).
  async redirects() {
    return [
      { source: '/signin', destination: '/auth?mode=signin', permanent: false },
      { source: '/signup', destination: '/auth?mode=signup', permanent: false },
    ];
  },
};

export default nextConfig;
