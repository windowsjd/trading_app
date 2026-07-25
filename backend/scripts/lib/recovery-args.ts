import { type ParsedApplyFlags, parseApplyDryRunFlags } from './cli-flags';

/**
 * Argument parser for dev-recover-local-data: the apply/dry-run safety contract
 * plus the market-data readiness flags. The market flags are stripped here so
 * the shared apply/dry-run parser still rejects any other unknown flag.
 */

export type RecoveryArgs = {
  flags: ParsedApplyFlags;
  ensureMarketSnapshots: boolean;
  operatorEmail?: string;
  operatorUserId?: string;
};

export function parseRecoveryArgs(argv: readonly string[]): RecoveryArgs {
  const passthrough: string[] = [];
  let ensureMarketSnapshots = false;
  let operatorEmail: string | undefined;
  let operatorUserId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--ensure-market-snapshots') {
      ensureMarketSnapshots = true;
      continue;
    }

    const inlineEmail = readInlineValue(arg, '--operator-email');
    if (inlineEmail !== null) {
      operatorEmail = inlineEmail;
      continue;
    }
    const inlineUserId = readInlineValue(arg, '--operator-user-id');
    if (inlineUserId !== null) {
      operatorUserId = inlineUserId;
      continue;
    }

    if (arg === '--operator-email' || arg === '--operator-user-id') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}.`);
      }
      if (arg === '--operator-email') {
        operatorEmail = value;
      } else {
        operatorUserId = value;
      }
      index += 1;
      continue;
    }

    passthrough.push(arg);
  }

  const flags = parseApplyDryRunFlags(passthrough, {
    allowSkipProviderValidation: true,
  });

  return { flags, ensureMarketSnapshots, operatorEmail, operatorUserId };
}

function readInlineValue(arg: string, name: string): string | null {
  const prefix = `${name}=`;
  return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}
