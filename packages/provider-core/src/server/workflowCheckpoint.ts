// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface WorkflowArtifactRecord {
  readonly path: string;
  readonly sha256: string;
}

export interface WorkflowStageRecord {
  readonly stageId: string;
  readonly completedAt: string;
  readonly artifacts: ReadonlyArray<WorkflowArtifactRecord>;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface WorkflowCheckpointState {
  readonly version: 1;
  readonly identityDigest: string;
  readonly updatedAt: string;
  readonly stages: Readonly<Record<string, WorkflowStageRecord>>;
}

export interface ComputeIdentityDigestInput {
  readonly workflowId?: string | undefined;
  readonly schemaVersion?: number | undefined;
  readonly config?: unknown;
  readonly inputFiles?: ReadonlyArray<string> | undefined;
  readonly inputHashes?: Readonly<Record<string, string>> | undefined;
}

export interface RecordWorkflowStageInput {
  readonly stageId: string;
  readonly completedAt?: string | undefined;
  readonly artifacts?: ReadonlyArray<WorkflowArtifactRecord> | undefined;
  readonly artifactPaths?: ReadonlyArray<string> | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface WorkflowStageDefinition {
  readonly stageId: string;
  readonly expectedArtifacts?: ReadonlyArray<string> | undefined;
}

export type WorkflowStageInvalidationReason =
  | "config_changed"
  | "missing_artifact"
  | "artifact_hash_mismatch"
  | "not_completed";

export type WorkflowStagePlanEntry =
  | {
      readonly stageId: string;
      readonly valid: true;
      readonly record: WorkflowStageRecord;
    }
  | {
      readonly stageId: string;
      readonly valid: false;
      readonly reason: WorkflowStageInvalidationReason;
    };

export interface WorkflowResumePlan {
  readonly statePath: string;
  readonly identityDigest: string;
  readonly checkpointExists: boolean;
  readonly configChanged: boolean;
  readonly stages: ReadonlyArray<WorkflowStagePlanEntry>;
  readonly validStageIds: ReadonlyArray<string>;
  readonly invalidatedStageIds: ReadonlyArray<string>;
}

let tempCheckpointSeq = 0;

function normalizePathSeparators(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function artifactMatchKey(filePath: string): string {
  const resolved = normalizePathSeparators(NodePath.resolve(filePath));
  return NodePath.sep === "\\" ? resolved.toLowerCase() : resolved;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalizeValue(item)));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeValue(entry);
      }
    }
    return sorted;
  }
  return String(value);
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function hashFileIfExists(filePath: string): Promise<string | null> {
  try {
    const buffer = await NodeFSP.readFile(filePath);
    return NodeCrypto.createHash("sha256").update(buffer).digest("hex");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function computeIdentityDigest(input: ComputeIdentityDigestInput): Promise<string> {
  const uniqueFiles = new Map<string, string>();
  for (const filePath of input.inputFiles ?? []) {
    const normalized = normalizePathSeparators(filePath);
    if (!uniqueFiles.has(normalized)) {
      uniqueFiles.set(normalized, filePath);
    }
  }

  const fileDigests = await Promise.all(
    [...uniqueFiles.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([normalizedPath, rawPath]) => {
        const sha256 = await hashFileIfExists(rawPath);
        return {
          path: normalizedPath,
          exists: sha256 !== null,
          sha256,
        };
      }),
  );

  const canonicalPayload = canonicalizeValue({
    version: 1,
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
    ...(input.schemaVersion !== undefined ? { schemaVersion: input.schemaVersion } : {}),
    config: input.config ?? null,
    inputHashes: input.inputHashes ?? {},
    inputFiles: fileDigests,
  });

  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
}

function parseStageRecord(raw: unknown): WorkflowStageRecord | null {
  if (raw === null || typeof raw !== "object") return null;
  const candidate = raw as Partial<WorkflowStageRecord>;
  if (typeof candidate.stageId !== "string" || typeof candidate.completedAt !== "string") {
    return null;
  }
  const artifacts: Array<WorkflowArtifactRecord> = [];
  if (Array.isArray(candidate.artifacts)) {
    for (const item of candidate.artifacts) {
      if (
        item !== null &&
        typeof item === "object" &&
        typeof (item as Partial<WorkflowArtifactRecord>).path === "string" &&
        typeof (item as Partial<WorkflowArtifactRecord>).sha256 === "string"
      ) {
        artifacts.push({
          path: (item as WorkflowArtifactRecord).path,
          sha256: (item as WorkflowArtifactRecord).sha256,
        });
      }
    }
  }
  return {
    stageId: candidate.stageId,
    completedAt: candidate.completedAt,
    artifacts,
    ...(candidate.metadata !== undefined &&
    candidate.metadata !== null &&
    typeof candidate.metadata === "object" &&
    !Array.isArray(candidate.metadata)
      ? { metadata: candidate.metadata }
      : {}),
  };
}

export async function loadWorkflowCheckpoint(
  statePath: string,
): Promise<WorkflowCheckpointState | null> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(statePath, "utf8");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<WorkflowCheckpointState>;
  if (
    candidate.version !== 1 ||
    typeof candidate.identityDigest !== "string" ||
    candidate.stages === null ||
    typeof candidate.stages !== "object" ||
    Array.isArray(candidate.stages)
  ) {
    return null;
  }

  const stages: Record<string, WorkflowStageRecord> = {};
  for (const [stageId, entry] of Object.entries(candidate.stages)) {
    const parsedStage = parseStageRecord(entry);
    if (parsedStage !== null) {
      stages[stageId] = parsedStage;
    }
  }

  return {
    version: 1,
    identityDigest: candidate.identityDigest,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    stages,
  };
}

async function writeCheckpointAtomic(
  statePath: string,
  state: WorkflowCheckpointState,
): Promise<void> {
  const dir = NodePath.dirname(statePath);
  await NodeFSP.mkdir(dir, { recursive: true });
  tempCheckpointSeq += 1;
  const tempPath = `${statePath}.${tempCheckpointSeq}.tmp`;
  try {
    await NodeFSP.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await NodeFSP.rename(tempPath, statePath);
  } catch (error) {
    try {
      if (NodeFS.existsSync(tempPath)) {
        await NodeFSP.rm(tempPath, { force: true });
      }
    } catch {
      // Ignore temp cleanup failure.
    }
    throw error;
  }
}

export async function recordStageCompleted(
  statePath: string,
  identityDigest: string,
  stageRecord: RecordWorkflowStageInput,
): Promise<WorkflowCheckpointState> {
  const resolvedArtifacts = new Map<string, WorkflowArtifactRecord>();

  for (const artifact of stageRecord.artifacts ?? []) {
    resolvedArtifacts.set(artifactMatchKey(artifact.path), {
      path: artifact.path,
      sha256: artifact.sha256,
    });
  }

  for (const artifactPath of stageRecord.artifactPaths ?? []) {
    const sha256 = await hashFileIfExists(artifactPath);
    if (sha256 === null) {
      throw new Error(`Cannot checkpoint missing artifact at '${artifactPath}'.`);
    }
    resolvedArtifacts.set(artifactMatchKey(artifactPath), {
      path: artifactPath,
      sha256,
    });
  }

  const timestamp = stageRecord.completedAt ?? new Date().toISOString();
  const normalizedStage: WorkflowStageRecord = {
    stageId: stageRecord.stageId,
    completedAt: timestamp,
    artifacts: [...resolvedArtifacts.values()],
    ...(stageRecord.metadata !== undefined ? { metadata: stageRecord.metadata } : {}),
  };

  const existing = await loadWorkflowCheckpoint(statePath);
  const baseStages: Record<string, WorkflowStageRecord> =
    existing !== null && existing.identityDigest === identityDigest ? { ...existing.stages } : {};

  baseStages[stageRecord.stageId] = normalizedStage;

  const nextState: WorkflowCheckpointState = {
    version: 1,
    identityDigest,
    updatedAt: timestamp,
    stages: baseStages,
  };

  await writeCheckpointAtomic(statePath, nextState);
  return nextState;
}

export async function planResumableStages(
  stages: ReadonlyArray<string | WorkflowStageDefinition>,
  statePath: string,
  identityDigest: string,
): Promise<WorkflowResumePlan> {
  const normalizedStages: ReadonlyArray<WorkflowStageDefinition> = stages.map((stage) =>
    typeof stage === "string" ? { stageId: stage } : stage,
  );
  const checkpoint = await loadWorkflowCheckpoint(statePath);

  if (checkpoint === null) {
    const entries: ReadonlyArray<WorkflowStagePlanEntry> = normalizedStages.map((stage) => ({
      stageId: stage.stageId,
      valid: false,
      reason: "not_completed",
    }));
    return {
      statePath,
      identityDigest,
      checkpointExists: false,
      configChanged: false,
      stages: entries,
      validStageIds: [],
      invalidatedStageIds: entries.map((entry) => entry.stageId),
    };
  }

  if (checkpoint.identityDigest !== identityDigest) {
    const entries: ReadonlyArray<WorkflowStagePlanEntry> = normalizedStages.map((stage) => ({
      stageId: stage.stageId,
      valid: false,
      reason: "config_changed",
    }));
    return {
      statePath,
      identityDigest,
      checkpointExists: true,
      configChanged: true,
      stages: entries,
      validStageIds: [],
      invalidatedStageIds: entries.map((entry) => entry.stageId),
    };
  }

  const entries: Array<WorkflowStagePlanEntry> = [];
  for (const stage of normalizedStages) {
    const record = Object.hasOwn(checkpoint.stages, stage.stageId)
      ? checkpoint.stages[stage.stageId]
      : undefined;

    if (record === undefined) {
      entries.push({
        stageId: stage.stageId,
        valid: false,
        reason: "not_completed",
      });
      continue;
    }

    const recordedByKey = new Map<string, WorkflowArtifactRecord>();
    for (const artifact of record.artifacts) {
      recordedByKey.set(artifactMatchKey(artifact.path), artifact);
    }

    let invalidReason: WorkflowStageInvalidationReason | undefined;

    for (const expectedPath of stage.expectedArtifacts ?? []) {
      if (!recordedByKey.has(artifactMatchKey(expectedPath))) {
        invalidReason = "missing_artifact";
        break;
      }
    }

    if (invalidReason === undefined) {
      for (const artifact of record.artifacts) {
        const currentHash = await hashFileIfExists(artifact.path);
        if (currentHash === null) {
          invalidReason = "missing_artifact";
          break;
        }
        if (currentHash !== artifact.sha256) {
          invalidReason = "artifact_hash_mismatch";
          break;
        }
      }
    }

    if (invalidReason !== undefined) {
      entries.push({
        stageId: stage.stageId,
        valid: false,
        reason: invalidReason,
      });
    } else {
      entries.push({
        stageId: stage.stageId,
        valid: true,
        record,
      });
    }
  }

  return {
    statePath,
    identityDigest,
    checkpointExists: true,
    configChanged: false,
    stages: entries,
    validStageIds: entries.filter((entry) => entry.valid).map((entry) => entry.stageId),
    invalidatedStageIds: entries.filter((entry) => !entry.valid).map((entry) => entry.stageId),
  };
}
