import { cacheLife } from 'next/cache.js'
import { loadRemoteImage } from './remote-image'

// Shared by every instance in the region (Runtime Cache), so a design's images are
// fetched once, not on every preview. A failed fetch throws and is never cached.
export async function cachedRemoteImage(url: string): Promise<string> {
  'use cache: remote'
  cacheLife({ revalidate: 86400, expire: 7 * 86400 })
  return loadRemoteImage(url)
}
