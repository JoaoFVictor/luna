const REMOTE_PATH_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GIT_SCP_PATTERN =
  /^git@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i;

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

function normalizedRemotePath(hostname: string, pathname: string): string | undefined {
  const path = pathname.replace(/^\/+/, "");
  const match = REMOTE_PATH_PATTERN.exec(path);

  if (match === null) {
    return undefined;
  }

  const [, owner, repo] = match;

  return `${hostname.toLowerCase()}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export function normalizeRemoteUrl(value: string): string {
  const remoteUrl = value.trim();
  const scpMatch = GIT_SCP_PATTERN.exec(remoteUrl);

  if (scpMatch !== null) {
    const [, hostname, owner, repo] = scpMatch;

    return `${hostname.toLowerCase()}/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }

  try {
    const parsed = new URL(remoteUrl);
    const isHttps = parsed.protocol === "https:";
    const isGitSsh =
      parsed.protocol === "ssh:" &&
      parsed.username === "git";

    if (isHttps) {
      if (
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.search !== "" ||
        parsed.hash !== ""
      ) {
        throw remoteUrlError(
          "HTTPS remote URLs must not include credentials, query, or fragment"
        );
      }

      const path = normalizedRemotePath(parsed.hostname, parsed.pathname);

      if (path !== undefined) {
        return path;
      }
    }

    if (isGitSsh) {
      const path = normalizedRemotePath(parsed.hostname, parsed.pathname);

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
