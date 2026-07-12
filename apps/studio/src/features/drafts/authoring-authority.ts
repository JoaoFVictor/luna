export type AuthoringAuthorityState = {
  readonly data: unknown
  readonly isFetching: boolean
  readonly isError: boolean
}

export function authoringAuthorityUnavailable(
  hasLocalChanges: boolean,
  authorities: readonly AuthoringAuthorityState[],
): boolean {
  return hasLocalChanges || authorities.some(
    (authority) =>
      authority.data === undefined ||
      authority.isFetching ||
      authority.isError,
  )
}
