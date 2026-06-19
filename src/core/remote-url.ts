const GITHUB_HOST = "github.com";
const GITHUB_PATH_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_SCP_PATTERN =
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i;

function normalizedGithubPath(pathname: string): string | undefined {
  const path = pathname.replace(/^\/+/, "");
  const match = GITHUB_PATH_PATTERN.exec(path);

  if (match === null) {
    return undefined;
  }

  const [, owner, repo] = match;

  return `${GITHUB_HOST}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export function normalizeRemoteUrl(value: string): string {
  const remoteUrl = value.trim();
  const scpMatch = GITHUB_SCP_PATTERN.exec(remoteUrl);

  if (scpMatch !== null) {
    const [, owner, repo] = scpMatch;

    return `${GITHUB_HOST}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  try {
    const parsed = new URL(remoteUrl);
    const isGithubHttps =
      parsed.protocol === "https:" && parsed.hostname.toLowerCase() === GITHUB_HOST;
    const isGithubSsh =
      parsed.protocol === "ssh:" &&
      parsed.hostname.toLowerCase() === GITHUB_HOST &&
      parsed.username === "git";

    if (isGithubHttps || isGithubSsh) {
      const path = normalizedGithubPath(parsed.pathname);

      if (path !== undefined) {
        return path;
      }
    }
  } catch {
    // Fall through to the conservative fallback for unsupported URL shapes.
  }

  return remoteUrl;
}

export function remoteUrlMatches(
  actual: string,
  expected: readonly string[]
): boolean {
  const normalizedActual = normalizeRemoteUrl(actual);

  return expected.some(
    (expectedUrl) => normalizeRemoteUrl(expectedUrl) === normalizedActual
  );
}
