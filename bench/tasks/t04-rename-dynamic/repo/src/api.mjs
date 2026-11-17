const users = { 1: { id: 1, name: "Ada" }, 2: { id: 2, name: "Lin" } };

export function getUser(id) {
  return users[id] ?? null;
}
