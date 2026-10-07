export const roles = ['viewer', 'user', 'admin'];
export function availableRoles(assignedRole) {
  return process.env.DEMO_ROLE_SWITCH === 'true' ? roles : roles.slice(0, roles.indexOf(assignedRole) + 1);
}
export function can(role, action) {
  return {
    readBots: roles.includes(role),
    manageBots: ['user', 'admin'].includes(role),
    manageUsers: role === 'admin'
  }[action] === true;
}
