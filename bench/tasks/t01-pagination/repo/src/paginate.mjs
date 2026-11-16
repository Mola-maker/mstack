export function pageCount(total, size) {
  return Math.floor(total / size);
}

export function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}
