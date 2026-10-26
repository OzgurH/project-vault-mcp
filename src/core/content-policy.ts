import { VaultError } from './errors.js';
import type { Project } from './types.js';

// Deliberately narrow signatures. This is an exposure guard, not a DLP classifier.
const SECRET_SIGNATURES = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
];

export function assertContentPolicy(project: Project, content: string): void {
  if (project.config.security?.blockSecrets === false) return;
  if (SECRET_SIGNATURES.some(pattern => pattern.test(content))) {
    throw new VaultError('CONTENT_RESTRICTED', 'Note contains a recognized credential or private-key signature and cannot be exposed or written.');
  }
}
