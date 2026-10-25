/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: { formats: ['image/avif', 'image/webp'] },
  // The stylesheet is a linked, cached file. Inlining it (experimental.inlineCss) put ~75 KB of CSS into every page twice
  // (the <style> tag and the RSC payload), which cost more on a phone than the one CSS request it saved.
  // Sign in and sign up live on one page now; old links keep working (query strings such as ?site= pass through).
  async redirects() {
    return [
      { source: '/signin', destination: '/auth?mode=signin', permanent: false },
      { source: '/signup', destination: '/auth?mode=signup', permanent: false },
    ];
  },
};

export default nextConfig;
