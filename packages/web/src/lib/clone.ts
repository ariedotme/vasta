/** Deep copy of plain JSON data. Works on Vue reactive proxies, unlike structuredClone. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
