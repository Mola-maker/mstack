const users = { 1: { id: 1, name: "Ada" }, 2: { id: 2, name: "Lin" } };

export function fetchUser(id) {
  return users[id] ?? null;
}
