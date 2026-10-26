/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: import.meta.dirname,
    // class-variance-authority still imports clsx; resolve it to cn so the bundle
    // carries one class-merging implementation.
    resolveAlias: { clsx: 'cn', 'tailwind-merge': 'cn' },
  },
  // The DESIGN.md catalog is read from disk when a new chat picks one.
  outputFileTracingIncludes: { '/api/prompt': ['./lib/design-md/*.md'] },
}

export default nextConfig
