/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile the workspace contracts package rather than pre-building it,
  // so type changes are picked up without a separate build step.
  transpilePackages: ['@arf/contracts'],
};

export default nextConfig;
