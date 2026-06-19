const GITHUB_HOST = "github.com";
const GITHUB_PATH_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_SCP_PATTERN =
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i;

type RemoteUrlError = Error & { code: "remote_url_unsafe" };

function remoteUrlError(message: string): RemoteUrlError {
  const error = new Error(message) as RemoteUrlError;
  error.code = "remote_url_unsafe";

  return error;
}

function isRemoteUrlError(error: unknown): error is RemoteUrlError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "remote_url_unsafe"
  );
}

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

    if (isGithubHttps) {
      if (
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        throw remoteUrlError(
          "GitHub HTTPS remote URLs must not include credentials, query, or fragment"
        );
      }

      const path = normalizedGithubPath(parsed.pathname);

      if (path !== undefined) {
        return path;
      }
    }

    if (isGithubSsh) {
      const path = normalizedGithubPath(parsed.pathname);

      if (path !== undefined) {
        return path;
      }
    }
  } catch (error) {
    if (isRemoteUrlError(error)) {
      throw error;
    }

    // Fall through to the conservative fallback for unsupported URL shapes.
  }

  return remoteUrl;
}

export function remoteUrlMatches(
  actual: string,
  expected: readonly string[]
): boolean {
  let normalizedActual: string;

  try {
    normalizedActual = normalizeRemoteUrl(actual);
  } catch {
    return false;
  }

  return expected.some(
    (expectedUrl) => normalizeRemoteUrl(expectedUrl) === normalizedActual
  );
}
