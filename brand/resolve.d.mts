/** Type face of the root brand resolver for TypeScript consumers run through tsx. */
export interface BrandProfile {
  readonly key: string
  readonly productName: string
  readonly shortName: string
  readonly tagline: string
  readonly brandColor: string
  readonly backgroundColor: string
  readonly themeColor: string
  readonly artifactPrefix: string
  readonly homeDir: string
}
export const BRAND_ROOT: string
export const REPO_ROOT: string
export function loadProfile(key: string): BrandProfile
export const brand: BrandProfile
export const artifactPrefix: string
export const releaseBrand: BrandProfile
