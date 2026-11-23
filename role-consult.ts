// Distinct from the old broker capability that required a local grant.
export const ROLE_CONSULT_FEATURE = "role-consult-task-v1";

export function validConsultId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(value);
}
