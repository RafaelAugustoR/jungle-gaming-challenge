// Console permissions mirror the realm's composite roles: viewer < operator < demo-operator.
// The backend enforces them; the console only hides what a profile cannot do.
export type Role = 'viewer' | 'operator' | 'demo-operator';

const rank: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, 'demo-operator': 2 };

export const can = (role: Role, required: Role) => rank[role] >= rank[required];

export const roleLabel: Readonly<Record<Role, string>> = {
  'demo-operator': 'executa provas',
  operator: 'consulta e reconcilia',
  viewer: 'só consulta',
};

/** The highest console role in a token, or undefined when it has none. */
export function highestRole(hasRole: (role: Role) => boolean): Role | undefined {
  return (['demo-operator', 'operator', 'viewer'] as const).find(hasRole);
}
