import { DomainError, type DomainErrorCode } from '../domain/errors/domain-error';
import { isTransientPostgresError, pgCode, pgConstraint } from './postgres-error';
export async function databaseOperation<T>(
  work: () => Promise<T>,
  uniqueConflicts: Readonly<Record<string, DomainErrorCode>> = {},
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const constraint = pgConstraint(error);
    if (pgCode(error) === '23505' && constraint && Object.hasOwn(uniqueConflicts, constraint))
      throw new DomainError(uniqueConflicts[constraint]!);
    if (isTransientPostgresError(error)) throw new DomainError('INFRASTRUCTURE_UNAVAILABLE');
    throw error;
  }
}
