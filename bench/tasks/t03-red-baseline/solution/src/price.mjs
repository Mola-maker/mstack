export function legacyRound(x) {
  return Math.round(x);
}

export function formatPrice(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`cents must be an integer, got ${cents}`);
  const abs = Math.abs(cents);
  const body = `$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${body}` : body;
}
