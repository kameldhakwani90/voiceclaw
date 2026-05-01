const GITHUB_RELEASES_API =
  "https://api.github.com/repos/yagudaev/voiceclaw/releases"
const RELEASES_FALLBACK_URL = "https://github.com/yagudaev/voiceclaw/releases"
const RELEASE_REVALIDATE_SECONDS = 300
const DESKTOP_TAG_PREFIX = "desktop-v"

type GitHubRelease = {
  tag_name: string
  name: string | null
  html_url: string
  draft: boolean
  prerelease: boolean
  assets: GitHubAsset[]
}

type GitHubAsset = {
  name: string
  browser_download_url: string
  content_type: string
  size: number
}

export type MacReleaseDownload = {
  tagName: string
  releaseName: string
  releaseUrl: string
  assetName: string
  downloadUrl: string
  size: number
  isPrerelease: boolean
}

export async function getLatestMacReleaseDownload(): Promise<MacReleaseDownload | null> {
  try {
    const response = await fetch(GITHUB_RELEASES_API, {
      headers: githubHeaders(),
      next: {
        revalidate: RELEASE_REVALIDATE_SECONDS,
      },
    })

    if (!response.ok) {
      return null
    }

    const releases = (await response.json()) as GitHubRelease[]
    const desktopReleases = releases
      .filter((r) => !r.draft && r.tag_name.startsWith(DESKTOP_TAG_PREFIX))
      .sort((a, b) => compareDesktopTags(b.tag_name, a.tag_name))

    for (const release of desktopReleases) {
      const dmg = release.assets.find(isMacDmgAsset)
      if (!dmg) continue

      return {
        tagName: release.tag_name,
        releaseName: release.name ?? release.tag_name,
        releaseUrl: release.html_url,
        assetName: dmg.name,
        downloadUrl: dmg.browser_download_url,
        size: dmg.size,
        isPrerelease: release.prerelease,
      }
    }
  } catch {
    return null
  }

  return null
}

export function getMacDownloadFallbackUrl() {
  return RELEASES_FALLBACK_URL
}

function isMacDmgAsset(asset: GitHubAsset) {
  return (
    asset.name.toLowerCase().endsWith(".dmg") ||
    asset.content_type === "application/x-apple-diskimage"
  )
}

function compareDesktopTags(a: string, b: string): number {
  const aParts = parseDesktopTag(a)
  const bParts = parseDesktopTag(b)
  for (let i = 0; i < 3; i++) {
    if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i]
  }
  return 0
}

function parseDesktopTag(tag: string): [number, number, number] {
  const match = tag.match(/^desktop-v(\d+)\.(\d+)\.(\d+)/)
  if (!match) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function githubHeaders() {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  return headers
}
