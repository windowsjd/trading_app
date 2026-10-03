import { ConsoleLogger } from '@nestjs/common';
import {
  recordAdminApplicationLog,
  sanitizeAdminLogArgument,
} from './admin-diagnostics';

/**
 * Redacts ConsoleLogger arguments and mirrors only logs emitted
 * inside the current HTTP AsyncLocalStorage context into its bounded buffer.
 * Background logs and logs from other requests never enter that buffer.
 */
export class AdminDiagnosticLogger extends ConsoleLogger {
  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(
      sanitizeAdminLogArgument(message),
      ...optionalParams.map(sanitizeAdminLogArgument),
    );
    recordAdminApplicationLog('info', message, optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(
      sanitizeAdminLogArgument(message),
      ...optionalParams.map(sanitizeAdminLogArgument),
    );
    recordAdminApplicationLog('warn', message, optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(
      sanitizeAdminLogArgument(message),
      ...optionalParams.map(sanitizeAdminLogArgument),
    );
    recordAdminApplicationLog('error', message, optionalParams);
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(
      sanitizeAdminLogArgument(message),
      ...optionalParams.map(sanitizeAdminLogArgument),
    );
    recordAdminApplicationLog('debug', message, optionalParams);
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(
      sanitizeAdminLogArgument(message),
      ...optionalParams.map(sanitizeAdminLogArgument),
    );
    recordAdminApplicationLog('debug', message, optionalParams);
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(
      sanitizeAdminLogArgument(message),
      ...optionalParams.map(sanitizeAdminLogArgument),
    );
    recordAdminApplicationLog('error', message, optionalParams);
  }
}
