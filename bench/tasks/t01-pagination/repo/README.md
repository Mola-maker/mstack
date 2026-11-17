# paginate

`paginate(items, page, size)` returns one page of `items`. Pages count from 1.

- `page` or `size` below 1, or not an integer: throw `RangeError`.
- A page past the last one: return `[]`.
- The last page may be shorter than `size`.

`pageCount(total, size)` is the number of pages (0 when `total` is 0).
