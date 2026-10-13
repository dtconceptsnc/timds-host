export const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export function storageError(error) {
  if (error?.statusCode) throw error;
  throw fail(/constraint|unique/i.test(String(error?.message)) ? 409 : 503,
    /constraint|unique/i.test(String(error?.message)) ? 'Collaboration state changed; retry the operation' : 'Collaboration storage is unavailable');
}
export const json = value => JSON.stringify(value);
export const decode = value => value == null ? null : JSON.parse(value);
export const principalId = actor => actor?.principalId || actor?.id || actor?.userId;
