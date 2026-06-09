import { execFile } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import * as path from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface OrgRepo {
  name: string
  cloneUrl: string
  defaultBranch?: string
}

/**
 * Pluggable source of repositories for `nevan index --org`. The live
 * implementation (GitHubRepoProvider) hits the real GitHub REST API and runs
 * real `git clone`; tests inject a fake that fabricates local directories.
 */
export interface RepoProvider {
  listRepos(org: string): Promise<OrgRepo[]>
  /** Clone (or update) `repo` under `destParentDir`; return the local repo path. */
  cloneRepo(repo: OrgRepo, destParentDir: string): Promise<string>
}

/** Extract the org/user slug from inputs like `github.com/myorg` or `https://github.com/myorg/`. */
export function parseOrgFromUrl(input: string): string {
  let s = input.trim()
  s = s.replace(/^https?:\/\//i, '')
  s = s.replace(/^(www\.)?github\.com\//i, '')
  s = s.replace(/\.git$/i, '')
  s = s.replace(/\/+$/, '')
  return s.split('/')[0] ?? ''
}

interface GitHubRepoApi {
  name: string
  clone_url: string
  default_branch: string
  archived: boolean
  fork: boolean
}

/**
 * Live GitHub provider. Lists an org's (or user's) repos via the REST API and
 * clones each shallowly. Needs network access and — for private repos / higher
 * rate limits — a token (GITHUB_TOKEN / GH_TOKEN).
 */
export class GitHubRepoProvider implements RepoProvider {
  constructor(
    private readonly token?: string,
    private readonly apiBase = 'https://api.github.com',
    private readonly includeArchived = false,
    private readonly includeForks = false,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nevan-code',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  async listRepos(org: string): Promise<OrgRepo[]> {
    const out: OrgRepo[] = []
    // Try the org endpoint first; fall back to the user endpoint on 404.
    for (const kind of ['orgs', 'users'] as const) {
      let ok = true
      for (let page = 1; page <= 20; page++) {
        const url = `${this.apiBase}/${kind}/${encodeURIComponent(org)}/repos?per_page=100&page=${page}&type=all`
        const res = await fetch(url, { headers: this.headers() })
        if (!res.ok) {
          if (res.status === 404 && kind === 'orgs') {
            ok = false
            break // fall through to users endpoint
          }
          const body = await res.text().catch(() => '')
          throw new Error(`GitHub API ${res.status} listing repos for "${org}": ${body.slice(0, 200)}`)
        }
        const batch = (await res.json()) as GitHubRepoApi[]
        if (!Array.isArray(batch) || batch.length === 0) break
        for (const r of batch) {
          if (r.archived && !this.includeArchived) continue
          if (r.fork && !this.includeForks) continue
          out.push({ name: r.name, cloneUrl: r.clone_url, defaultBranch: r.default_branch })
        }
        if (batch.length < 100) break
      }
      if (ok) return out
    }
    return out
  }

  async cloneRepo(repo: OrgRepo, destParentDir: string): Promise<string> {
    const dest = path.join(destParentDir, repo.name)
    await fs.mkdir(destParentDir, { recursive: true })

    if (existsSync(path.join(dest, '.git'))) {
      // Already cloned — fast-forward to pick up changes (T2.6 incremental).
      await execFileAsync('git', ['-C', dest, 'pull', '--ff-only'], {
        maxBuffer: 64 * 1024 * 1024,
      }).catch(() => {
        // A pull failure (diverged/offline) is non-fatal; index what we have.
      })
      return dest
    }

    let url = repo.cloneUrl
    if (this.token && url.startsWith('https://')) {
      url = url.replace('https://', `https://x-access-token:${this.token}@`)
    }
    await execFileAsync('git', ['clone', '--depth', '1', url, dest], {
      maxBuffer: 64 * 1024 * 1024,
    })
    return dest
  }
}
