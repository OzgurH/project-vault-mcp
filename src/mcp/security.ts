import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { DEFAULT_SECURITY, MAX_CONFIG_BYTES } from '../core/config.js';
import { VaultError } from '../core/errors.js';
import { readBoundedBytes, sha256Hex } from '../core/files.js';
import { assertPlainAncestors } from '../core/paths.js';
import type { Project } from '../core/types.js';

export interface AuditEvent {
  event: 'tool_request';
  requestId: string;
  timestamp: string;
  tool: string;
  outcome: 'success' | 'applied' | 'denied' | 'error';
  code?: string;
  durationMs: number;
}
export type AuditSink = (event: AuditEvent) => void;

/** A process-local capability boundary, not a remote identity provider. */
export class RequestSecurity {
  private readonly policy;
  private readonly initialConfig: Promise<string | null>;
  private active = 0;
  private windowAt = performance.now();
  private requests = 0;
  private auditRecords = 0;

  constructor(private readonly project: Project, private readonly sink: AuditSink = (event) => {
    process.stderr.write(JSON.stringify(event) + '\n');
  }) {
    this.policy = { ...DEFAULT_SECURITY, ...project.config.security };
    // Attach the rejection handler immediately; startup failures become denied tool calls.
    this.initialConfig = project.configRevision ? Promise.resolve(project.configRevision) : this.configDigest().catch(() => null);
  }

  private async configDigest(): Promise<string> {
    await assertPlainAncestors(path.dirname(this.project.configPath));
    const stat = await fs.lstat(this.project.configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid configuration boundary');
    return sha256Hex(await readBoundedBytes(this.project.configPath, MAX_CONFIG_BYTES, 'Configuration'));
  }

  private audit(tool: string, started: number, outcome: AuditEvent['outcome'], code?: string): void {
    if (!this.policy.audit || this.auditRecords >= this.policy.maxRequestsPerMinute * 2) return;
    this.auditRecords++;
    try {
      this.sink({ event: 'tool_request', requestId: randomUUID(), timestamp: new Date().toISOString(), tool,
        outcome, ...(code ? { code } : {}), durationMs: Math.max(0, Math.round(performance.now() - started)) });
    } catch { /* Best-effort diagnostics must not misreport an already applied write. */ }
  }

  async run<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    if (started - this.windowAt >= 60000) {
      this.windowAt = started;
      this.requests = 0;
      this.auditRecords = 0;
    }
    let admitted = false;
    try {
      if (this.requests >= this.policy.maxRequestsPerMinute) throw new VaultError('RATE_LIMITED', 'Request budget exhausted; retry after the current minute.');
      this.requests++;
      if (this.active >= this.policy.maxConcurrentRequests) throw new VaultError('SERVER_BUSY', 'Too many concurrent requests; retry later.');
      this.active++;
      admitted = true;
      const initial = await this.initialConfig;
      let current: string | null = null;
      try { current = await this.configDigest(); } catch { /* Fail closed below. */ }
      if (!initial || current !== initial) throw new VaultError('POLICY_CHANGED', 'Configuration changed or is inaccessible; restart the server to load the current policy.');
      const value = await fn();
      const payload = value !== null && typeof value === 'object' && 'structuredContent' in value ? value.structuredContent : value;
      const applied = payload !== null && typeof payload === 'object' && 'applied' in payload && payload.applied === true;
      this.audit(tool, started, applied ? 'applied' : 'success');
      return value;
    } catch (error) {
      const code = error instanceof VaultError ? error.code : 'INTERNAL_ERROR';
      this.audit(tool, started, ['RATE_LIMITED', 'SERVER_BUSY', 'POLICY_CHANGED', 'PRIVATE_NOTE', 'CONTENT_RESTRICTED', 'PATH_EXCLUDED', 'WRITES_DISABLED'].includes(code) ? 'denied' : 'error', code);
      throw error;
    } finally {
      if (admitted) this.active--;
    }
  }
}
