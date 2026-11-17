function check(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`expected an integer >= 1, got ${n}`);
}

export function pageCount(total, size) {
  check(size);
  return Math.ceil(total / size);
}

export function paginate(items, page, size) {
  check(page);
  check(size);
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
