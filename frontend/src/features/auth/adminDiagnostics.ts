import type { AdminDiagnosticDto } from '../../models/dto/common.ts';
import type { UserRole } from '../../models/dto/user.ts';

export function shouldShowAdminDiagnostic(
  role: UserRole | null | undefined,
  diagnostic: AdminDiagnosticDto | null | undefined,
): diagnostic is AdminDiagnosticDto {
  return role === 'admin' && Boolean(diagnostic);
}
