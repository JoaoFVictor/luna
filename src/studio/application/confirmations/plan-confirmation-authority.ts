import { studioDigestsEqual } from "./digests.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type StudioPlanConfirmationAuthority = {
  readonly planId: string;
  readonly actorBindingDigest: string;
  readonly requestDigest: string;
  readonly snapshotDigest: string;
};

export type StudioPlanConfirmationBindingIdentity = Omit<
  StudioPlanConfirmationAuthority,
  "snapshotDigest"
>;

export type StudioPlanConfirmationConsumeExpectation = Pick<
  StudioPlanConfirmationAuthority,
  "planId" | "actorBindingDigest"
>;

type ConfirmationRecord<TBinding> = {
  readonly binding: TBinding;
  readonly expiresAt: number;
};

type ConfirmationPort<TBinding, TRecord extends ConfirmationRecord<TBinding>> = {
  issue(
    binding: TBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }>;
  consume(
    token: string,
    expectation: StudioPlanConfirmationConsumeExpectation
  ): Promise<TRecord | undefined>;
};

export type StudioPlanConfirmationAuthorityHelper<
  TBinding,
  TRecord extends ConfirmationRecord<TBinding>
> = {
  issue(
    binding: TBinding,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }>;
  consume(
    token: string,
    expectation: StudioPlanConfirmationConsumeExpectation
  ): Promise<TRecord | undefined>;
  verify(
    binding: TBinding,
    expected: StudioPlanConfirmationAuthority
  ): boolean;
};

function validAuthority(authority: StudioPlanConfirmationAuthority): boolean {
  return authority.planId.trim() !== "" &&
    DIGEST_PATTERN.test(authority.actorBindingDigest) &&
    DIGEST_PATTERN.test(authority.requestDigest) &&
    DIGEST_PATTERN.test(authority.snapshotDigest);
}

export function studioPlanConfirmationAuthoritiesEqual(
  actual: StudioPlanConfirmationAuthority,
  expected: StudioPlanConfirmationAuthority
): boolean {
  return validAuthority(actual) &&
    validAuthority(expected) &&
    actual.planId === expected.planId &&
    studioDigestsEqual(
      actual.actorBindingDigest,
      expected.actorBindingDigest
    ) &&
    studioDigestsEqual(actual.requestDigest, expected.requestDigest) &&
    studioDigestsEqual(actual.snapshotDigest, expected.snapshotDigest);
}

export function studioPlanConfirmationExpectationMatches(
  binding: Pick<
    StudioPlanConfirmationBindingIdentity,
    "planId" | "actorBindingDigest"
  >,
  expectation: StudioPlanConfirmationConsumeExpectation
): boolean {
  return binding.planId.trim() !== "" &&
    DIGEST_PATTERN.test(binding.actorBindingDigest) &&
    binding.planId === expectation.planId &&
    DIGEST_PATTERN.test(expectation.actorBindingDigest) &&
    studioDigestsEqual(
      binding.actorBindingDigest,
      expectation.actorBindingDigest
    );
}

export function createStudioPlanConfirmationAuthority<
  TBinding extends StudioPlanConfirmationBindingIdentity,
  TRecord extends ConfirmationRecord<TBinding>
>(options: {
  readonly confirmations: ConfirmationPort<TBinding, TRecord>;
  readonly snapshotDigestOf: (binding: TBinding) => string;
  readonly invalidAuthorityError: () => Error;
}): StudioPlanConfirmationAuthorityHelper<TBinding, TRecord> {
  const authorityOf = (
    binding: TBinding
  ): StudioPlanConfirmationAuthority => ({
    planId: binding.planId,
    actorBindingDigest: binding.actorBindingDigest,
    requestDigest: binding.requestDigest,
    snapshotDigest: options.snapshotDigestOf(binding)
  });
  return Object.freeze({
    issue: async (
      binding: TBinding,
      issueOptions: { readonly ttlMs: number }
    ) => {
      if (!validAuthority(authorityOf(binding))) {
        throw options.invalidAuthorityError();
      }
      return await options.confirmations.issue(binding, issueOptions);
    },
    consume: async (
      token: string,
      expectation: StudioPlanConfirmationConsumeExpectation
    ) => await options.confirmations.consume(token, expectation),
    verify: (
      binding: TBinding,
      expected: StudioPlanConfirmationAuthority
    ) => studioPlanConfirmationAuthoritiesEqual(
      authorityOf(binding),
      expected
    )
  });
}
