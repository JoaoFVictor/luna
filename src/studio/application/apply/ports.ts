import type { StudioDraftLockPort } from "../drafts/persistence.js";
import type {
  StudioApplyFileDiff,
  StudioApplyResult
} from "../../contracts/apply.js";
import type { StudioPath, StudioResourceRef } from "../../contracts/paths.js";

export type StudioApplySourceFile = {
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
};

export type StudioApplySourcePort = {
  read(
    file: StudioPath,
    options: { readonly maxBytes: number }
  ): Promise<StudioApplySourceFile | undefined>;
};

export type StudioStoredApplyPlan = {
  readonly binding: StudioApplyPlanBinding;
  readonly expectedResourceRevisions: Readonly<Record<string, string>>;
};

export type StudioApplyPlanBinding = {
  readonly draftId: string;
  readonly recordRevision: number;
  readonly contentRevision: number;
  readonly layoutRevision: number;
  readonly draftHash: string;
  readonly baseBundleHash: string | null;
  readonly baseFiles: readonly {
    readonly file: StudioPath;
    readonly sha256: string | null;
    readonly mode: number | null;
  }[];
  readonly dependencies: readonly {
    readonly file: StudioPath;
    readonly sha256: string;
  }[];
  readonly resourceRevisions: Readonly<Record<string, string | null>>;
  readonly technicalCatalogFingerprint: string;
  readonly compilerContractVersion: string;
  readonly diffDigest: string;
  readonly planDigest: string;
};

export type StudioApplyPlanRecord = {
  readonly tokenDigest: string;
  readonly expiresAt: number;
  readonly plan: StudioStoredApplyPlan;
};

export type StudioApplyPlanTokenPort = {
  issue(
    plan: StudioStoredApplyPlan,
    options: { readonly ttlMs: number }
  ): Promise<{ readonly token: string; readonly expiresAt: number }>;
  get(token: string): Promise<StudioApplyPlanRecord | undefined>;
};

export type StudioApplyTransactionEntry = {
  readonly file: StudioPath;
  readonly action: "write" | "delete";
  readonly beforeSha256: string | null;
  readonly beforeMode: number | null;
  readonly afterSha256: string | null;
  readonly content?: Uint8Array;
  readonly mode?: number;
};

export type StudioApplyGuard = {
  readonly file: StudioPath;
  readonly sha256: string | null;
  readonly mode?: number | null;
};

export type StudioApplyVerificationContext = {
  readonly resources: readonly StudioResourceRef[];
  readonly expectedResourceRevisions: Readonly<Record<string, string>>;
  readonly technicalCatalogFingerprint: string;
  readonly compilerContractVersion: string;
};

export type StudioInstalledApplyVerificationPort = {
  verify(
    context: StudioApplyVerificationContext
  ): Promise<Readonly<Record<string, string>>>;
};

export type StudioApplyTransactionInput = {
  readonly operationId: string;
  readonly draftId: string;
  readonly recordRevision: number;
  readonly draftHash: string;
  readonly requestHash: string;
  readonly idempotencyKeyHash: string;
  readonly planTokenHash: string;
  readonly planDigest: string;
  readonly allowedFiles: readonly StudioPath[];
  readonly entries: readonly StudioApplyTransactionEntry[];
  readonly guards: readonly StudioApplyGuard[];
  readonly diff: readonly StudioApplyFileDiff[];
  readonly verification: StudioApplyVerificationContext;
};

export type StudioApplyJournalState =
  | "prepared"
  | "backed_up"
  | "installing"
  | "verifying"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "recovery_required";

export type StudioApplyAttempt = {
  readonly operationId: string;
  readonly requestHash: string;
  readonly state: StudioApplyJournalState;
  readonly result?: StudioApplyResult;
};

export type StudioApplyRecoveryResult = {
  readonly recovered: readonly string[];
  readonly committed: readonly string[];
  readonly recoveryRequired: readonly string[];
};

export type StudioApplyTransactionPort = {
  findByIdempotencyKeyHash(
    idempotencyKeyHash: string
  ): Promise<StudioApplyAttempt | undefined>;
  execute(
    input: StudioApplyTransactionInput,
    verifier: StudioInstalledApplyVerificationPort
  ): Promise<StudioApplyResult>;
  recover(
    verifier: StudioInstalledApplyVerificationPort
  ): Promise<StudioApplyRecoveryResult>;
};

export type StudioApplyLockPort = StudioDraftLockPort;
