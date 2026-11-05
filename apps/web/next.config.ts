import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The app imports the shared analysis core from the repo root (../dist and
  // ../prices.json), so the workspace root is the repo, not this directory.
  // Two lockfiles exist here, so Turbopack cannot infer it correctly.
  turbopack: { root: path.join(__dirname, '..') },
};

export default nextConfig;
