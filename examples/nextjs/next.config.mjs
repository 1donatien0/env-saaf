/** @type {import('next').NextConfig} */
const nextConfig = {
  // examples/ has its own package.json; pin the trace root so Next does not
  // infer the repository root from the lockfiles it finds above this folder.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
