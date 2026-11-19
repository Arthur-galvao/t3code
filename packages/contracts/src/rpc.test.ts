import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AssetCreateUrlResult, AttachmentCreateUploadUrlResult } from "./assets.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const rsiGetSummaryRpc = WsRpcGroup.requests.get(WS_METHODS.rsiGetTelemetrySummary);
const rsiQueryLessonsRpc = WsRpcGroup.requests.get(WS_METHODS.rsiQueryLessons);
const rsiRecordLessonRpc = WsRpcGroup.requests.get(WS_METHODS.rsiRecordLesson);
const rsiDemoteLessonRpc = WsRpcGroup.requests.get(WS_METHODS.rsiDemoteLesson);
const rsiDeleteLessonRpc = WsRpcGroup.requests.get(WS_METHODS.rsiDeleteLesson);

const decodeRsiGetSummary = rsiGetSummaryRpc
  ? Schema.decodeUnknownExit(rsiGetSummaryRpc.payloadSchema)
  : undefined;
const decodeRsiQueryLessons = rsiQueryLessonsRpc
  ? Schema.decodeUnknownExit(rsiQueryLessonsRpc.payloadSchema)
  : undefined;
const decodeRsiRecordLesson = rsiRecordLessonRpc
  ? Schema.decodeUnknownExit(rsiRecordLessonRpc.payloadSchema)
  : undefined;
const decodeRsiDemoteLesson = rsiDemoteLessonRpc
  ? Schema.decodeUnknownExit(rsiDemoteLessonRpc.payloadSchema)
  : undefined;
const decodeRsiDeleteLesson = rsiDeleteLessonRpc
  ? Schema.decodeUnknownExit(rsiDeleteLessonRpc.payloadSchema)
  : undefined;

describe("WebSocket RPC contracts", () => {
  it("only accepts asset and upload URLs on their own server routes", () => {
    const decodeAsset = Schema.decodeUnknownExit(AssetCreateUrlResult);
    const decodeUpload = Schema.decodeUnknownExit(AttachmentCreateUploadUrlResult);
    const expiresAt = 10_000;

    expect(
      Exit.isSuccess(
        decodeAsset({ relativeUrl: "/api/assets/token.sig/my%20file.png", expiresAt }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeUpload({
          relativeUrl: "/api/attachments/upload/token.sig",
          expiresAt,
          attachmentId: "attachment",
        }),
      ),
    ).toBe(true);

    for (const relativeUrl of [
      "data:text/plain,hello",
      "file:///tmp/document",
      "https://other.example/document",
      "//other.example/document",
      "/api/assets/token/../../../other",
    ]) {
      expect(Exit.isFailure(decodeAsset({ relativeUrl, expiresAt }))).toBe(true);
      expect(
        Exit.isFailure(decodeUpload({ relativeUrl, expiresAt, attachmentId: "attachment" })),
      ).toBe(true);
    }
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });

  it("registers RSI telemetry and lesson RPC contracts with expected payloads and permissions", () => {
    if (
      !decodeRsiGetSummary ||
      !decodeRsiQueryLessons ||
      !decodeRsiRecordLesson ||
      !decodeRsiDemoteLesson ||
      !decodeRsiDeleteLesson
    ) {
      throw new Error("Expected all 5 RSI RPCs to be registered in WsRpcGroup");
    }

    expect(Exit.isSuccess(decodeRsiGetSummary({}))).toBe(true);
    expect(Exit.isSuccess(decodeRsiGetSummary({ threadId: "t-1", limit: 10 }))).toBe(true);
    expect(
      Exit.isSuccess(
        decodeRsiQueryLessons({
          scope: "glob",
          activePaths: ["src/index.ts"],
          minConfidence: 0.4,
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeRsiRecordLesson({ title: "  ", guidance: "use x" }))).toBe(true);
    expect(
      Exit.isSuccess(
        decodeRsiRecordLesson({
          title: "Verify paths",
          guidance: "Check file existence before editing.",
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeRsiDemoteLesson({ id: " " }))).toBe(true);
    expect(Exit.isSuccess(decodeRsiDemoteLesson({ id: "lesson-1", delta: 0.2 }))).toBe(true);
    expect(Exit.isFailure(decodeRsiDeleteLesson({ id: "" }))).toBe(true);
    expect(Exit.isSuccess(decodeRsiDeleteLesson({ id: "lesson-1" }))).toBe(true);

    expect(clientRpcRequiredScopes(WS_METHODS.rsiGetTelemetrySummary, {})).toEqual([]);
    expect(clientRpcRequiredScopes(WS_METHODS.rsiQueryLessons, {})).toEqual([]);
    expect(clientRpcRequiredScopes(WS_METHODS.rsiRecordLesson, {})).toEqual([
      "orchestration:operate",
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.rsiDemoteLesson, {})).toEqual([
      "orchestration:operate",
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.rsiDeleteLesson, {})).toEqual([
      "orchestration:operate",
    ]);
  });
});
