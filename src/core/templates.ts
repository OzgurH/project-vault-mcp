/**
 * Fixed English note templates.
 *
 * Every link is relative Markdown so the generated notes resolve in the
 * initialized layout:
 *   docs/index.md, docs/architecture/overview.md, docs/modules/index.md,
 *   docs/decisions/index.md, docs/runbooks/index.md
 * Only the index template links to other notes.
 */
import { VaultError } from './errors.js';

export const TEMPLATE_TYPES = ['index', 'architecture', 'module', 'adr', 'runbook'] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

const TEMPLATES: Record<TemplateType, string> = {
  index: [
    '---',
    'type: index',
    'status: draft',
    '---',
    '# Project Knowledge Index',
    '',
    'Entry point for this project\'s architecture knowledge. Keep this note short and link to the detailed notes.',
    '',
    '## Map',
    '',
    '- [Architecture overview](architecture/overview.md)',
    '- [Modules](modules/index.md)',
    '- [Decisions](decisions/index.md)',
    '- [Runbooks](runbooks/index.md)',
    '',
    '## Conventions',
    '',
    '- One note per module, decision or runbook.',
    '- Record the reason behind a decision, not only the outcome.',
    '- Declared source hashes prove byte equality only, never architectural correctness.',
    '',
  ].join('\n'),
  architecture: [
    '---',
    'type: architecture',
    'status: draft',
    '---',
    '# Architecture Overview',
    '',
    '## Purpose',
    '',
    'What the system does and for whom.',
    '',
    '## Components',
    '',
    'The main building blocks and their responsibilities.',
    '',
    '## Data Flow',
    '',
    'How requests, events and data move through the components.',
    '',
    '## Boundaries and Constraints',
    '',
    'External systems, trust boundaries, non-functional requirements.',
    '',
    '## Open Questions',
    '',
    '- ',
    '',
  ].join('\n'),
  module: [
    '---',
    'type: module',
    'status: draft',
    '---',
    '# Module Name',
    '',
    '## Responsibility',
    '',
    'What this module owns and what it explicitly does not own.',
    '',
    '## Public Interface',
    '',
    'Entry points, contracts and important types.',
    '',
    '## Dependencies',
    '',
    'Modules and external services this module relies on.',
    '',
    '## Notes',
    '',
    'Pitfalls, invariants and known limitations.',
    '',
  ].join('\n'),
  adr: [
    '---',
    'type: adr',
    'status: proposed',
    '---',
    '# ADR: Decision Title',
    '',
    '## Context',
    '',
    'The situation and the forces at play.',
    '',
    '## Decision',
    '',
    'What was decided and why.',
    '',
    '## Consequences',
    '',
    'Positive, negative and neutral effects of the decision.',
    '',
    '## Alternatives Considered',
    '',
    '- ',
    '',
  ].join('\n'),
  runbook: [
    '---',
    'type: runbook',
    'status: draft',
    '---',
    '# Runbook: Procedure Title',
    '',
    '## When to Use',
    '',
    'Symptoms or triggers that call for this procedure.',
    '',
    '## Preconditions',
    '',
    'Access, tools and checks required before starting.',
    '',
    '## Steps',
    '',
    '1. ',
    '',
    '## Verification',
    '',
    'How to confirm the procedure succeeded.',
    '',
    '## Rollback',
    '',
    'How to undo the change if verification fails.',
    '',
  ].join('\n'),
};

function isTemplateType(type: string): type is TemplateType {
  return (TEMPLATE_TYPES as readonly string[]).includes(type);
}

/** Return the fixed template for a supported note type; unknown types are rejected. */
export function getTemplate(type: string): string {
  if (typeof type !== 'string' || !isTemplateType(type)) {
    throw new VaultError('UNKNOWN_TEMPLATE', `Unknown template type; supported types are ${TEMPLATE_TYPES.join(', ')}`);
  }
  return TEMPLATES[type];
}
