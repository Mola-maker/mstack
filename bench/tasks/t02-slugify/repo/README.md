# slugify

`slugify(text)` makes a URL slug:

1. Lower-case it.
2. Remove accents (`é` becomes `e`).
3. Every run of characters that are not a-z or 0-9 becomes one `-`.
4. No `-` at the start or the end.
5. An empty result is the string `"untitled"`.
