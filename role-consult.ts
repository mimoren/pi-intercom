import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const ROLE_CONSULT_FEATURE = "role-consult-v1";
export const CONSULT_TTL_MS = 30 * 60 * 1000;
export const CONSULT_BUDGET = 10;

export interface ConsultScope {
  taskId: string;
  roleId: string;
  workspaceId: string;
}

export interface ConsultGrant extends ConsultScope {
  ownerEpoch: string;
  cwd: string;
  expiresAt: number;
  remaining: number;
}

export function validConsultId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value);
}

// The approval happens in macOS, outside the Pi input and RPC channels. Do not
// use UI callbacks, stdout from callers, or a remembered authentication window.
const OWNER_AUTH = `
import Foundation
import LocalAuthentication
let context = LAContext()
context.localizedFallbackTitle = ""
context.touchIDAuthenticationAllowableReuseDuration = 0
var error: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
      let scope = ProcessInfo.processInfo.environment["PI_INTERCOM_CONSULT_REASON"] else { exit(2) }
let finished = DispatchSemaphore(value: 0)
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: scope) { approved, error in
    if let error = error as NSError? {
        FileHandle.standardError.write(Data("LocalAuthentication \\(error.code)\\n".utf8))
    }
    exit(approved ? 0 : 1)
}
_ = finished.wait(timeout: .now() + 40)
exit(1)
`;

export async function approveRoleConsultation(scope: ConsultScope, cwd: string, sessionId: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const reason = `Allow ${CONSULT_BUDGET} read-only Intercom consultations for task ${scope.taskId} with ${scope.roleId} in workspace ${scope.workspaceId}, project ${cwd}, session ${sessionId}, for 30 minutes`;
  try {
    await promisify(execFile)("/usr/bin/swift", ["-e", OWNER_AUTH], {
      env: { ...process.env, PI_INTERCOM_CONSULT_REASON: reason },
      timeout: 45_000,
      maxBuffer: 16_384,
    });
    return true;
  } catch {
    return false;
  }
}
