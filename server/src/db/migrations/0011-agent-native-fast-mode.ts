import { createHash } from 'node:crypto'

export const AGENT_NATIVE_FAST_MODE_SQL = `
ALTER TABLE participants ADD COLUMN native_fast_mode BOOLEAN NOT NULL DEFAULT false;
`

export function agentNativeFastModeChecksum(): string {
  return createHash('sha256').update(AGENT_NATIVE_FAST_MODE_SQL).digest('hex')
}
