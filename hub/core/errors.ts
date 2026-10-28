/** Structured errors. Every refusal the Hub issues carries a stable code. */

export const MESH_ERRORS = {
  NOT_INITIALIZED: 'MESH_NOT_INITIALIZED',
  UNKNOWN_ENTITY: 'MESH_UNKNOWN_ENTITY',
  SCHEMA_INVALID: 'MESH_SCHEMA_INVALID',
  TRANSITION_ILLEGAL: 'MESH_TRANSITION_ILLEGAL',
  LOCK_TIMEOUT: 'MESH_LOCK_TIMEOUT',
  SESSION_UNKNOWN: 'MESH_SESSION_UNKNOWN',
  SESSION_HELLO_REQUIRED: 'MESH_SESSION_HELLO_REQUIRED',
  SESSION_ROLE_MISMATCH: 'MESH_SESSION_ROLE_MISMATCH',
  SESSION_DEAD: 'MESH_SESSION_DEAD',
  ROLE_FORBIDDEN: 'MESH_ROLE_FORBIDDEN',
  SOD_VIOLATION: 'MESH_SOD_VIOLATION',
  CAPABILITY_MISSING: 'MESH_CAPABILITY_MISSING',
  SCOPE_VIOLATION: 'MESH_SCOPE_VIOLATION',
  GRANULARITY: 'MESH_GRANULARITY',
  CLAIM_CONFLICT: 'MESH_CLAIM_CONFLICT',
  DEPENDENCY_UNMET: 'MESH_DEPENDENCY_UNMET',
  REVIEW_NOT_INDEPENDENT: 'MESH_REVIEW_NOT_INDEPENDENT',
  REVIEW_MISSING: 'MESH_REVIEW_MISSING',
  GIT_FAILED: 'MESH_GIT_FAILED',
  CONFIG_INVALID: 'MESH_CONFIG_INVALID',
  BUS_BYPASS: 'MESH_BUS_BYPASS',
  ARTIFACT_DENIED: 'MESH_ARTIFACT_DENIED',
  INTERNAL: 'MESH_INTERNAL',
} as const

export type MeshErrorCode = (typeof MESH_ERRORS)[keyof typeof MESH_ERRORS]

export class MeshError extends Error {
  readonly code: MeshErrorCode
  readonly detail: Record<string, unknown>

  constructor(code: MeshErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'MeshError'
    this.code = code
    this.detail = detail
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, detail: this.detail }
  }
}

export function isMeshError(e: unknown): e is MeshError {
  return e instanceof MeshError
}
