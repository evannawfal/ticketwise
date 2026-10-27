const basePath = process.env.NEXT_BASE_PATH || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the admin is plain files on S3 + CloudFront (or GitHub Pages for the demo).
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_DEMO: process.env.NEXT_PUBLIC_DEMO || "",
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
